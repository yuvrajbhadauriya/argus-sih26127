// ═══════════════════════════════════════════════════════════════════════
// Server-only Supabase access for the /api functions (service-role key).
//
// The database is private: the anon role has no table access at all
// (supabase/migrations/20261001000700_private_database.sql). Every read and
// write the dashboard makes goes through /api/data/*, which uses this module.
//
// - Plain fetch against PostgREST (/rest/v1) and GoTrue (/auth/v1): no SDK in
//   the function bundle, and trivially mockable in tests.
// - SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY come from the server env only
//   (Vercel project env; .env via the dev bridge). They are never included in
//   a response or an error message.
// - Writes carry the signed-in operator as X-Argus-Actor-Id / -Email request
//   headers. PostgREST exposes them to SQL as request.headers, and the audit
//   triggers use them when the caller is service_role (auth.uid() is null
//   there) — see 20261001000600_audit_actor_headers.sql.
// ═══════════════════════════════════════════════════════════════════════

type Env = Record<string, string | undefined>;

export interface AdminConfig {
  url: string;
  key: string;
}

export function readAdminConfig(env: Env): AdminConfig | null {
  const url = (env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = (env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!/^https?:\/\//.test(url) || !key) return null;
  return { url, key };
}

/** A database / auth call failed. `message` is safe to show to clients. */
export class UpstreamError extends Error {
  readonly status: number;
  /** PostgREST error code (e.g. PGRST116, 42703) when known — for logs and fallbacks only. */
  readonly code: string | null;
  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface Actor {
  id: string;
  email: string;
  role: string;
}

/** The subset of a GoTrue user the API needs. */
export interface AuthUserInfo {
  id: string;
  email: string;
  role: string;
}

const TIMEOUT_MS = 8000;
const HEADER_SAFE = /[^\x20-\x7e]/g;

export class SupabaseAdmin {
  private readonly cfg: AdminConfig;
  private readonly doFetch: typeof fetch;

  constructor(cfg: AdminConfig, doFetch: typeof fetch = fetch) {
    this.cfg = cfg;
    this.doFetch = doFetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { apikey: this.cfg.key, Authorization: `Bearer ${this.cfg.key}`, Accept: 'application/json', ...extra };
  }

  private static actorHeaders(actor?: Actor): Record<string, string> {
    if (!actor) return {};
    return {
      'X-Argus-Actor-Id': actor.id.replace(HEADER_SAFE, '').slice(0, 64),
      'X-Argus-Actor-Email': actor.email.replace(HEADER_SAFE, '').slice(0, 128),
    };
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await this.doFetch(`${this.cfg.url}${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new UpstreamError(502, 'Database is unreachable');
    }
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    if (!res.ok) {
      const code = body && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string' ? (body as { code: string }).code : null;
      throw new UpstreamError(res.status, `Database request failed (HTTP ${res.status})`, code);
    }
    return body;
  }

  /** GET /rest/v1/<table>?<params>. Always an array. */
  async select<T = Record<string, unknown>>(table: string, params: Record<string, string> | URLSearchParams): Promise<T[]> {
    const qs = params instanceof URLSearchParams ? params : new URLSearchParams(params);
    const body = await this.request(`/rest/v1/${encodeURIComponent(table)}?${qs.toString()}`, { method: 'GET', headers: this.headers() });
    return Array.isArray(body) ? (body as T[]) : [];
  }

  /** INSERT one row; returns the stored row. */
  async insert<T = Record<string, unknown>>(table: string, row: Record<string, unknown>, actor?: Actor): Promise<T> {
    const body = await this.request(`/rest/v1/${encodeURIComponent(table)}?select=*`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json', Prefer: 'return=representation', ...SupabaseAdmin.actorHeaders(actor) }),
      body: JSON.stringify(row),
    });
    const rows = Array.isArray(body) ? body : [];
    if (!rows.length) throw new UpstreamError(502, 'Database did not return the stored row');
    return rows[0] as T;
  }

  /** UPDATE rows matching `filter` (column → value, compared with eq); returns the updated rows. */
  async update<T = Record<string, unknown>>(
    table: string,
    patch: Record<string, unknown>,
    filter: Record<string, string>,
    actor?: Actor,
  ): Promise<T[]> {
    const qs = new URLSearchParams({ select: '*' });
    for (const [k, v] of Object.entries(filter)) qs.set(k, `eq.${v}`);
    const body = await this.request(`/rest/v1/${encodeURIComponent(table)}?${qs.toString()}`, {
      method: 'PATCH',
      headers: this.headers({ 'Content-Type': 'application/json', Prefer: 'return=representation', ...SupabaseAdmin.actorHeaders(actor) }),
      body: JSON.stringify(patch),
    });
    return Array.isArray(body) ? (body as T[]) : [];
  }

  /**
   * Validates a user's access token with GoTrue (what supabase-js
   * `auth.getUser(token)` does). Null when the token is missing, expired or
   * revoked. The role is app_metadata.role (server-set only), '' when absent.
   */
  async getUser(token: string): Promise<AuthUserInfo | null> {
    let res: Response;
    try {
      res = await this.doFetch(`${this.cfg.url}/auth/v1/user`, {
        method: 'GET',
        headers: { apikey: this.cfg.key, Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new UpstreamError(502, 'Auth service is unreachable');
    }
    if (res.status === 401 || res.status === 403 || res.status === 404) return null;
    if (!res.ok) throw new UpstreamError(502, `Auth service failed (HTTP ${res.status})`);
    let u: Record<string, unknown>;
    try {
      u = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new UpstreamError(502, 'Auth service returned an invalid answer');
    }
    if (!u || typeof u.id !== 'string') return null;
    const meta = (u.app_metadata && typeof u.app_metadata === 'object' ? u.app_metadata : {}) as Record<string, unknown>;
    return {
      id: u.id,
      email: typeof u.email === 'string' ? u.email : '',
      role: typeof meta.role === 'string' ? meta.role.toLowerCase() : '',
    };
  }
}
