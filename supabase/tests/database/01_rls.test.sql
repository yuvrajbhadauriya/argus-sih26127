-- pgTAP: row level security, grants and the audit trail.
-- Run with `supabase test db` (local stack) — see docs/DATABASE.md.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(29);

-- ── Fixtures (as the migration owner) ────────────────────────────────────
INSERT INTO public.cameras (id, name, code, lat, lng, zone, direction, status, video_url)
VALUES ('cam-test-1', 'Test Junction', 'TT-01', 19.0, 72.8, 'Test', 'Northbound', 'online', 'x.mp4');
INSERT INTO public.detections (event_id, camera_id, plate_text_raw, plate_text_normalized,
                               confidence_score, vehicle_type, detected_at, lat, lng, bbox)
VALUES ('evt-test-1', 'cam-test-1', 'MH 01 AB 1234', 'MH01AB1234', 0.9, 'car',
        '2026-09-29T09:00:00+05:30', 19.0, 72.8, '{"x":1,"y":2,"width":3,"height":4}');
INSERT INTO public.alerts (id, detection_id, plate_text, camera_id, camera_name,
                           priority, category, reason, lat, lng)
VALUES ('alert-test-1', 'evt-test-1', 'MH 01 AB 1234', 'cam-test-1', 'Test Junction',
        'high', 'stolen', 'test', 19.0, 72.8);

-- ── Catalog checks ───────────────────────────────────────────────────────
SELECT is(
  (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity),
  0, 'RLS is enabled on every public table');
SELECT is(
  (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relforcerowsecurity),
  0, 'RLS is forced on every public table');
SELECT ok(
  (SELECT 'security_invoker=true' = ANY (reloptions) FROM pg_class WHERE oid = 'public.vehicles'::regclass),
  'vehicles view is security_invoker');
SELECT ok(
  (SELECT 'security_invoker=true' = ANY (reloptions) FROM pg_class WHERE oid = 'public.trajectories'::regclass),
  'trajectories view is security_invoker');
SELECT ok(
  NOT has_function_privilege('anon', 'public.purge_old_detections(int)', 'EXECUTE'),
  'anon cannot execute purge_old_detections');
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.purge_old_detections(int)', 'EXECUTE'),
  'authenticated cannot execute purge_old_detections');

-- ── Private database (20261001000700): anon has no access at all ─────────
SELECT is(
  (SELECT count(*)::int FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')),
  0, 'anon/authenticated hold no table or view privileges');
SELECT is(
  (SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public'
     AND roles && ARRAY['anon', 'authenticated', 'public']::name[]),
  0, 'no RLS policy targets anon/authenticated');

SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
SET LOCAL ROLE anon;

SELECT throws_ok($$SELECT * FROM public.cameras$$, '42501', NULL, 'anon cannot read cameras');
SELECT throws_ok($$SELECT * FROM public.detections$$, '42501', NULL, 'anon cannot read detections');
SELECT throws_ok($$SELECT * FROM public.alerts$$, '42501', NULL, 'anon cannot read alerts');
SELECT throws_ok($$SELECT * FROM public.blacklist_entries$$, '42501', NULL, 'anon cannot read the watchlist');
SELECT throws_ok($$SELECT * FROM public.vehicles$$, '42501', NULL, 'anon cannot read the vehicles view');
SELECT throws_ok($$SELECT * FROM public.trajectories$$, '42501', NULL, 'anon cannot read the trajectories view');
SELECT throws_ok($$SELECT * FROM public.model_status$$, '42501', NULL, 'anon cannot read model_status');
SELECT throws_ok($$SELECT * FROM public.audit_logs$$, '42501', NULL, 'anon cannot read audit logs');
SELECT throws_ok($$INSERT INTO public.detections (event_id, camera_id, plate_text_raw, plate_text_normalized,
                   confidence_score, vehicle_type, bbox) VALUES ('evt-anon', 'cam-test-1', 'X', 'X', 1, 'car', '{}')$$,
                 '42501', NULL, 'anon cannot insert detections');
SELECT throws_ok($$UPDATE public.alerts SET status = 'acknowledged'$$, '42501', NULL, 'anon cannot acknowledge alerts');
SELECT throws_ok($$SELECT public.purge_old_detections(1)$$, '42501', NULL, 'anon cannot purge detections');

RESET ROLE;

-- ── authenticated (even an operator JWT) goes through the API too ─────────
SELECT set_config('request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000000b","email":"op@example.com","app_metadata":{"role":"operator"}}', true);
SET LOCAL ROLE authenticated;

SELECT throws_ok($$SELECT * FROM public.alerts$$, '42501', NULL, 'authenticated cannot read alerts directly');
SELECT throws_ok($$UPDATE public.alerts SET status = 'acknowledged' WHERE id = 'alert-test-1'$$, '42501', NULL,
                 'authenticated cannot write alerts directly');
SELECT throws_ok($$INSERT INTO public.blacklist_entries (plate_text, category, priority, reason)
                   VALUES ('KA 01 AA 0001', 'stolen', 'high', 'x')$$, '42501', NULL,
                 'authenticated cannot add watchlist entries directly');

RESET ROLE;

-- ── /api/data writes: service_role + verified actor headers, audited ─────
-- A spoofed actor header is ignored for any role but service_role.
SELECT set_config('request.headers', '{"x-argus-actor-id":"spoof","x-argus-actor-email":"spoof@example.com"}', true);
SELECT set_config('request.jwt.claims', '{"role":"authenticated"}', true);
SELECT is(public.request_actor(), '{}'::jsonb, 'actor headers are ignored unless the caller is service_role');

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT set_config('request.headers',
  '{"x-argus-actor-id":"00000000-0000-0000-0000-00000000000b","x-argus-actor-email":"op@example.com"}', true);
SET LOCAL ROLE service_role;

UPDATE public.alerts SET status = 'acknowledged', acknowledged_by = 'op@example.com' WHERE id = 'alert-test-1';
SELECT is((SELECT acknowledged_by FROM public.alerts WHERE id = 'alert-test-1')::text, 'op@example.com',
          'acknowledged_by is the API-verified operator');
SELECT is((SELECT acknowledged FROM public.alerts WHERE id = 'alert-test-1'), true,
          'status and legacy acknowledged flag stay in sync');
SELECT lives_ok($$INSERT INTO public.blacklist_entries (plate_text, category, priority, reason)
                  VALUES ('KA 01 AA 0001', 'stolen', 'high', 'operator add')$$,
                'the API (service_role) can add a watchlist entry');
SELECT is(
  (SELECT user_id FROM public.audit_logs WHERE action = 'alert.acknowledge' AND entity_id = 'alert-test-1')::text,
  '00000000-0000-0000-0000-00000000000b', 'acknowledgement is audited with the operator id');
SELECT is(
  (SELECT user_email FROM public.audit_logs WHERE action = 'watchlist.insert'
     AND details::jsonb -> 'new' ->> 'plate_text_normalized' = 'KA01AA0001')::text,
  'op@example.com', 'watchlist insert is audited with the operator email');

RESET ROLE;

-- ── service_role (pipeline) bypasses RLS ─────────────────────────────────
SET LOCAL ROLE service_role;
SELECT lives_ok($$SELECT public.purge_old_detections(36500)$$, 'service_role can run the retention purge');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
