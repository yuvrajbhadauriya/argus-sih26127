-- ═══════════════════════════════════════════════════════════════════════════
-- Audit actor for writes made through the server API (service_role)
--
-- With the private database (20261001000700_private_database.sql) every
-- dashboard write goes through /api/data/* (api/_lib/dataRoutes.ts), which
-- verifies the operator's Supabase JWT and then writes with the service-role
-- key. Under service_role auth.uid() / auth.jwt()->>'email' are NULL, so the
-- API forwards the verified operator as request headers:
--
--   X-Argus-Actor-Id     auth.users.id of the operator
--   X-Argus-Actor-Email  their email
--
-- PostgREST exposes request headers to SQL as the `request.headers` GUC. They
-- are trusted ONLY when the request's JWT role is service_role (only the
-- server holds that key); for every other role they are ignored, so a client
-- can never spoof the actor.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.request_actor()
RETURNS JSONB
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
DECLARE
  h JSONB;
BEGIN
  IF coalesce(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RETURN '{}'::jsonb;
  END IF;
  BEGIN
    h := nullif(current_setting('request.headers', true), '')::jsonb;
  EXCEPTION WHEN others THEN
    h := NULL;
  END;
  RETURN jsonb_strip_nulls(jsonb_build_object(
    'id', nullif(left(h ->> 'x-argus-actor-id', 64), ''),
    'email', nullif(left(h ->> 'x-argus-actor-email', 128), '')
  ));
END
$$;

-- Trigger helper: executed as the writing role (the acknowledge trigger is
-- not SECURITY DEFINER), so authenticated/service_role keep EXECUTE. It returns
-- {} for anything but service_role, and anon never gets it.
REVOKE ALL ON FUNCTION public.request_actor() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_actor() TO authenticated, service_role;

-- acknowledged_by: JWT email/uid for direct operator sessions, else the
-- API-forwarded actor, else what the (service-role) writer set.
CREATE OR REPLACE FUNCTION public.alerts_stamp_acknowledger()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.status = 'acknowledged' AND OLD.status IS DISTINCT FROM 'acknowledged' THEN
    NEW.acknowledged_at := now();
    NEW.acknowledged_by := coalesce(
      auth.jwt() ->> 'email',
      auth.uid()::text,
      public.request_actor() ->> 'email',
      NEW.acknowledged_by,
      current_user::text
    );
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.write_audit_log()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  rec JSONB;
  old_rec JSONB;
  act TEXT;
  actor JSONB := public.request_actor();
BEGIN
  rec := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  old_rec := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END;

  IF TG_TABLE_NAME = 'alerts' THEN
    IF TG_OP <> 'UPDATE' OR (rec ->> 'status') IS NOT DISTINCT FROM (old_rec ->> 'status') THEN
      RETURN NULL;  -- only status transitions (acknowledge/dismiss/...) are audited
    END IF;
    act := 'alert.' || CASE rec ->> 'status' WHEN 'acknowledged' THEN 'acknowledge'
                                            ELSE 'status:' || (rec ->> 'status') END;
  ELSE
    act := CASE TG_TABLE_NAME WHEN 'blacklist_entries' THEN 'watchlist' ELSE TG_TABLE_NAME END
           || '.' || lower(TG_OP);
  END IF;

  INSERT INTO public.audit_logs (id, action, entity_type, entity_id, user_id, user_email, details, "timestamp")
  VALUES (
    gen_random_uuid()::text,
    left(act, 64),
    TG_TABLE_NAME,
    left(coalesce(rec ->> 'id', ''), 64),
    left(coalesce(auth.uid()::text, actor ->> 'id', auth.jwt() ->> 'role', session_user::text), 64),
    left(coalesce(auth.jwt() ->> 'email', actor ->> 'email', ''), 128),
    jsonb_build_object('op', TG_OP, 'new', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE rec END,
                       'old', CASE WHEN TG_OP = 'DELETE' THEN rec ELSE old_rec END,
                       'via', CASE WHEN actor ? 'id' THEN 'api' ELSE NULL END)::text,
    now()
  );
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION public.write_audit_log() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.alerts_stamp_acknowledger() FROM PUBLIC, anon, authenticated;
