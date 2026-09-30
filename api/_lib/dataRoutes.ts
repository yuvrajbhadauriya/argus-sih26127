// ═══════════════════════════════════════════════════════════════════════
// /api/data/* — the dashboard's ONLY path to the database.
//
// The anon key can no longer read any table (private database). The public
// dashboard calls these routes instead; they run with the service-role key on
// the server and return only the columns the UI renders.
//
//   GET   cameras[?id=]                 camera registry
//   POST  cameras                       register a camera           (operator)
//   PATCH cameras?id=                   edit registry fields        (operator)
//   GET   alerts[?id=]                  alert queue, joined with detection/camera/watchlist
//   POST  alerts/acknowledge            { id }                      (operator)
//   GET   watchlist                     watchlist (blacklist_entries)
//   POST  watchlist                     add a plate                 (operator)
//   PATCH watchlist?id=                 edit an entry               (operator)
//   GET   detections?camera_id=         one clip's plate reads (bbox track)
//   GET   vehicles[?q=]                 vehicles view (plate search)
//   GET   trajectory?plate=             trajectories view row, else the plate's reads
//   GET   model-status                  AI engine heartbeat row
//   GET   audit-log[?limit=]            audit trail                 (operator)
//
// Writes need `Authorization: Bearer <Supabase access token>`; the token is
// verified with GoTrue and app_metadata.role must be operator or admin. The
// actor is stamped explicitly (acknowledged_by, audit headers) because
// auth.uid() is null under the service role.
//
// Public reads get short CDN caching (s-maxage) so polling browsers share one
// database query; everything user-specific is no-store. Per-IP rate limits
// guard the function itself.
// ═══════════════════════════════════════════════════════════════════════

import { errorResponse, json } from './http.js';
import { clientIp, createRateLimiter } from './rateLimit.js';
import { readAdminConfig, SupabaseAdmin, UpstreamError, type Actor } from './supabaseAdmin.js';

type Env = Record<string, string | undefined>;

export interface DataDeps {
  env?: Env;
  fetch?: typeof fetch;
  now?: () => number;
}

export const READ_LIMIT = { windowMs: 60_000, max: 300 };
export const WRITE_LIMIT = { windowMs: 60_000, max: 30 };
const readLimiter = createRateLimiter(READ_LIMIT);
const writeLimiter = createRateLimiter(WRITE_LIMIT);

/** Test hook. */
export function resetDataRateLimits(): void {
  readLimiter.reset();
  writeLimiter.reset();
}

/** Cache policies (Vercel CDN honours s-maxage; browsers revalidate). */
export const CACHE = {
  registry: 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
  detections: 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600',
  lists: 'public, max-age=0, s-maxage=15, stale-while-revalidate=60',
  alerts: 'public, max-age=0, s-maxage=5, stale-while-revalidate=10',
  status: 'public, max-age=0, s-maxage=2, stale-while-revalidate=5',
  none: 'no-store',
} as const;

const MAX_BODY_BYTES = 16 * 1024;
export const DETECTIONS_PAGE_SIZE = 1000;
export const DETECTIONS_MAX_ROWS = 20_000;
export const MODEL_STATUS_ID = 'gpu-primary';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PLATE_RE = /^[A-Z0-9]{1,16}$/;
const PRIORITIES = new Set(['critical', 'high', 'medium', 'low']);
const CATEGORIES = new Set(['stolen', 'wanted', 'missing', 'flagged', 'custom']);
const CAMERA_STATUSES = new Set(['online', 'offline', 'maintenance']);

// ── selects: only what the UI renders ────────────────────────────────────
export const CAMERA_COLUMNS = 'id,name,code,lat,lng,latitude,longitude,zone,direction,road,status,video_url,created_at';
export const ALERT_EMBED_SELECT =
  '*,detections(event_id,camera_id,plate_text_raw,detected_at,latitude,longitude,lat,lng,' +
  'cameras(id,name,code,latitude,longitude,lat,lng)),' +
  'blacklist_entries(id,plate_text,plate_text_normalized,priority,category,notes,reason)';
export const WATCHLIST_COLUMNS =
  'id,plate_text,plate_text_normalized,category,priority,reason,notes,valid_from,valid_to,is_active,created_at,updated_at';
export const DETECTION_COLUMNS =
  'event_id,camera_id,tracked_vehicle_id,plate_text_raw,plate_text_normalized,confidence_score,plate_confidence,vehicle_type,frame_timestamp_sec,bbox';
export const VEHICLE_COLUMNS = 'plate_text,plate_text_normalized,vehicle_type,first_seen,last_seen,detection_count,camera_count';
export const TRAJECTORY_DETECTION_SELECT =
  'camera_id,plate_text_raw,vehicle_type,detected_at,timestamp,latitude,longitude,lat,lng,cameras(name,code,latitude,longitude,lat,lng)';
export const MODEL_STATUS_COLUMNS =
  'id,state,eta_seconds,message,model_label,restarts,uptime_seconds,gpu_busy,started_at,last_heartbeat,updated_at';
export const AUDIT_COLUMNS = 'id,action,entity_type,entity_id,user_id,user_email,details,timestamp';

class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Ctx {
  request: Request;
  url: URL;
  db: SupabaseAdmin;
  now: () => number;
}

type RouteFn = (ctx: Ctx) => Promise<Response>;

// ── helpers ───────────────────────────────────────────────────────────────
function param(ctx: Ctx, name: string): string {
  return (ctx.url.searchParams.get(name) ?? '').trim();
}

function requireId(value: unknown, what = 'id'): string {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw new ApiError(400, `A valid "${what}" is required`);
  return value;
}

export function normalizePlate(plate: string): string {
  return plate.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new ApiError(413, 'Request body too large');
  const buf = new Uint8Array(await request.arrayBuffer());
  if (buf.length > MAX_BODY_BYTES) throw new ApiError(413, 'Request body too large');
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(buf) || 'null');
  } catch {
    throw new ApiError(400, 'Request body is not valid JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'Request body must be a JSON object');
  return body as Record<string, unknown>;
}

function str(v: unknown, field: string, max: number, required = false): string | undefined {
  if (v === undefined || v === null) {
    if (required) throw new ApiError(400, `"${field}" is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new ApiError(400, `"${field}" must be a string`);
  const s = v.trim();
  if (required && !s) throw new ApiError(400, `"${field}" is required`);
  if (s.length > max) throw new ApiError(400, `"${field}" is too long (max ${max})`);
  return s;
}

function num(v: unknown, field: string, min: number, max: number): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = typeof v === 'number' ? v : Number.NaN;
  if (!Number.isFinite(n) || n < min || n > max) throw new ApiError(400, `"${field}" must be a number between ${min} and ${max}`);
  return n;
}

function oneOf(v: unknown, field: string, allowed: Set<string>): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !allowed.has(v)) throw new ApiError(400, `"${field}" is not allowed`);
  return v;
}

function isoOrNull(v: unknown, field: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw new ApiError(400, `"${field}" must be an ISO date or null`);
  return new Date(v).toISOString();
}

/** Verifies the bearer token; requires app_metadata.role operator/admin. */
async function requireOperator(ctx: Ctx): Promise<Actor> {
  const auth = ctx.request.headers.get('authorization') || '';
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  if (!m) throw new ApiError(401, 'Sign in as an operator to do this');
  const user = await ctx.db.getUser(m[1]);
  if (!user) throw new ApiError(401, 'Your session has expired — sign in again');
  if (user.role !== 'operator' && user.role !== 'admin') throw new ApiError(403, 'Operator or admin role required');
  return { id: user.id, email: user.email || user.id, role: user.role };
}

const rows = (data: unknown[], cache: string) => json({ rows: data }, 200, { 'Cache-Control': cache });
const one = (row: unknown, cache: string) => json({ row: row ?? null }, 200, { 'Cache-Control': cache });

// ── cameras ───────────────────────────────────────────────────────────────
const getCameras: RouteFn = async (ctx) => {
  const id = param(ctx, 'id');
  const q: Record<string, string> = { select: CAMERA_COLUMNS, order: 'code.asc' };
  if (id) q.id = `eq.${requireId(id)}`;
  const data = await ctx.db.select('cameras', q);
  return id ? one(data[0], CACHE.registry) : rows(data, CACHE.registry);
};

const createCamera: RouteFn = async (ctx) => {
  const actor = await requireOperator(ctx);
  const b = await readJsonBody(ctx.request);
  const code = str(b.code, 'code', 32, true)!;
  if (!/^[A-Za-z0-9-]{1,32}$/.test(code)) throw new ApiError(400, '"code" may only contain letters, digits and hyphens');
  const lat = num(b.latitude, 'latitude', -90, 90);
  const lng = num(b.longitude, 'longitude', -180, 180);
  if (lat === undefined || lng === undefined) throw new ApiError(400, '"latitude" and "longitude" are required');
  const row = await ctx.db.insert(
    'cameras',
    {
      id: `cam-${code.toLowerCase()}`,
      name: str(b.name, 'name', 120, true),
      code,
      lat,
      lng,
      latitude: lat,
      longitude: lng,
      zone: str(b.zone, 'zone', 80, true),
      direction: str(b.direction, 'direction', 40, true),
      road: str(b.road, 'road', 120) ?? null,
      status: oneOf(b.status, 'status', CAMERA_STATUSES) ?? 'offline',
      video_url: '',
    },
    actor,
  );
  return json({ row }, 201);
};

const updateCamera: RouteFn = async (ctx) => {
  const actor = await requireOperator(ctx);
  const id = requireId(param(ctx, 'id'));
  const b = await readJsonBody(ctx.request);
  const patch: Record<string, unknown> = {};
  const name = str(b.name, 'name', 120);
  const zone = str(b.zone, 'zone', 80);
  const direction = str(b.direction, 'direction', 40);
  const road = str(b.road, 'road', 120);
  const status = oneOf(b.status, 'status', CAMERA_STATUSES);
  const lat = num(b.latitude, 'latitude', -90, 90);
  const lng = num(b.longitude, 'longitude', -180, 180);
  if (name !== undefined) patch.name = name;
  if (zone !== undefined) patch.zone = zone;
  if (direction !== undefined) patch.direction = direction;
  if (road !== undefined) patch.road = road || null;
  if (status !== undefined) patch.status = status;
  if (lat !== undefined) Object.assign(patch, { lat, latitude: lat });
  if (lng !== undefined) Object.assign(patch, { lng, longitude: lng });
  if (!Object.keys(patch).length) throw new ApiError(400, 'Nothing to update');
  patch.updated_at = new Date(ctx.now()).toISOString();
  const updated = await ctx.db.update('cameras', patch, { id }, actor);
  if (!updated.length) throw new ApiError(404, 'Camera not found');
  return json({ row: updated[0] });
};

// ── alerts ────────────────────────────────────────────────────────────────
const getAlerts: RouteFn = async (ctx) => {
  const id = param(ctx, 'id');
  const base: Record<string, string> = { order: 'created_at.desc', limit: '500' };
  if (id) base.id = `eq.${requireId(id)}`;
  let data: unknown[];
  try {
    data = await ctx.db.select('alerts', { ...base, select: ALERT_EMBED_SELECT });
  } catch (err) {
    // Embedding can fail on a partially migrated schema: retry without joins.
    if (!(err instanceof UpstreamError) || err.status >= 500) throw err;
    data = await ctx.db.select('alerts', { ...base, select: '*' });
  }
  return id ? one(data[0], CACHE.alerts) : rows(data, CACHE.alerts);
};

const acknowledgeAlert: RouteFn = async (ctx) => {
  const actor = await requireOperator(ctx);
  const b = await readJsonBody(ctx.request);
  const id = requireId(b.id);
  const updated = await ctx.db.update(
    'alerts',
    // acknowledged_by is set explicitly: under the service role the stamping
    // trigger has no JWT email/uid and keeps this value.
    { status: 'acknowledged', acknowledged: true, acknowledged_by: actor.email, acknowledged_at: new Date(ctx.now()).toISOString() },
    { id },
    actor,
  );
  if (!updated.length) throw new ApiError(404, 'Alert not found');
  return json({ row: updated[0] });
};

// ── watchlist ─────────────────────────────────────────────────────────────
const getWatchlist: RouteFn = async (ctx) => {
  const data = await ctx.db.select('blacklist_entries', { select: WATCHLIST_COLUMNS, order: 'created_at.desc', limit: '1000' });
  return rows(data, CACHE.lists);
};

const createWatchlistEntry: RouteFn = async (ctx) => {
  const actor = await requireOperator(ctx);
  const b = await readJsonBody(ctx.request);
  const plate = str(b.plate_text, 'plate_text', 20, true)!.toUpperCase();
  if (!PLATE_RE.test(normalizePlate(plate))) throw new ApiError(400, '"plate_text" is not a valid plate');
  const reason = str(b.reason, 'reason', 500, true)!;
  const ts = new Date(ctx.now()).toISOString();
  const row = await ctx.db.insert(
    'blacklist_entries',
    {
      id: `bl-${crypto.randomUUID()}`,
      plate_text: plate,
      category: oneOf(b.category, 'category', CATEGORIES) ?? 'stolen',
      priority: oneOf(b.priority, 'priority', PRIORITIES) ?? 'high',
      reason,
      notes: reason,
      valid_from: ts,
      valid_to: isoOrNull(b.valid_to, 'valid_to') ?? null,
      is_active: true,
      source: 'dashboard',
      created_by: actor.email,
    },
    actor,
  );
  return json({ row }, 201);
};

const updateWatchlistEntry: RouteFn = async (ctx) => {
  const actor = await requireOperator(ctx);
  const id = requireId(param(ctx, 'id'));
  const b = await readJsonBody(ctx.request);
  const patch: Record<string, unknown> = {};
  if (b.is_active !== undefined) {
    if (typeof b.is_active !== 'boolean') throw new ApiError(400, '"is_active" must be a boolean');
    patch.is_active = b.is_active;
  }
  const priority = oneOf(b.priority, 'priority', PRIORITIES);
  const category = oneOf(b.category, 'category', CATEGORIES);
  const reason = str(b.reason, 'reason', 500);
  const validTo = isoOrNull(b.valid_to, 'valid_to');
  if (priority !== undefined) patch.priority = priority;
  if (category !== undefined) patch.category = category;
  if (reason !== undefined) Object.assign(patch, { reason, notes: reason });
  if (validTo !== undefined) patch.valid_to = validTo;
  if (!Object.keys(patch).length) throw new ApiError(400, 'Nothing to update');
  patch.updated_at = new Date(ctx.now()).toISOString();
  const updated = await ctx.db.update('blacklist_entries', patch, { id }, actor);
  if (!updated.length) throw new ApiError(404, 'Watchlist entry not found');
  return json({ row: updated[0] });
};

// ── detections / vehicles / trajectories ──────────────────────────────────
const getDetections: RouteFn = async (ctx) => {
  const cameraId = requireId(param(ctx, 'camera_id'), 'camera_id');
  // PostgREST caps a response at 1000 rows; one clip holds thousands of reads.
  const all: unknown[] = [];
  for (let from = 0; from < DETECTIONS_MAX_ROWS; from += DETECTIONS_PAGE_SIZE) {
    const page = await ctx.db.select('detections', {
      select: DETECTION_COLUMNS,
      camera_id: `eq.${cameraId}`,
      order: 'frame_timestamp_sec.asc,event_id.asc',
      offset: String(from),
      limit: String(DETECTIONS_PAGE_SIZE),
    });
    all.push(...page);
    if (page.length < DETECTIONS_PAGE_SIZE) break;
  }
  return rows(all, CACHE.detections);
};

const getVehicles: RouteFn = async (ctx) => {
  const q = normalizePlate(param(ctx, 'q')).slice(0, 16);
  const params: Record<string, string> = { select: VEHICLE_COLUMNS, limit: q ? '200' : '100' };
  if (q) params.plate_text_normalized = `ilike.*${q}*`;
  else params.order = 'last_seen.desc';
  return rows(await ctx.db.select('vehicles', params), CACHE.lists);
};

const getTrajectory: RouteFn = async (ctx) => {
  const raw = param(ctx, 'plate');
  const plate = normalizePlate(raw);
  if (!PLATE_RE.test(plate)) throw new ApiError(400, 'A valid "plate" is required');
  const traj = await ctx.db.select('trajectories', { select: '*', plate_text_normalized: `eq.${plate}`, limit: '1' });
  if (traj.length) return json({ trajectory: traj[0], detections: [] }, 200, { 'Cache-Control': CACHE.lists });
  const dets = await ctx.db.select('detections', {
    select: TRAJECTORY_DETECTION_SELECT,
    plate_text_normalized: `eq.${plate}`,
    order: 'detected_at.asc',
    limit: '1000',
  });
  return json({ trajectory: null, detections: dets }, 200, { 'Cache-Control': CACHE.lists });
};

// ── model status / audit ──────────────────────────────────────────────────
const getModelStatus: RouteFn = async (ctx) => {
  const data = await ctx.db.select('model_status', { select: MODEL_STATUS_COLUMNS, id: `eq.${MODEL_STATUS_ID}`, limit: '1' });
  return one(data[0], CACHE.status);
};

const getAuditLog: RouteFn = async (ctx) => {
  await requireOperator(ctx);
  const limit = Math.min(1000, Math.max(1, Number.parseInt(param(ctx, 'limit') || '500', 10) || 500));
  const data = await ctx.db.select('audit_logs', { select: AUDIT_COLUMNS, order: 'timestamp.desc', limit: String(limit) });
  return json({ rows: data }, 200, { 'Cache-Control': CACHE.none, Vary: 'Authorization' });
};

// ── routing ───────────────────────────────────────────────────────────────
export const ROUTES: Record<string, Partial<Record<'GET' | 'POST' | 'PATCH', RouteFn>>> = {
  cameras: { GET: getCameras, POST: createCamera, PATCH: updateCamera },
  alerts: { GET: getAlerts },
  'alerts/acknowledge': { POST: acknowledgeAlert },
  watchlist: { GET: getWatchlist, POST: createWatchlistEntry, PATCH: updateWatchlistEntry },
  detections: { GET: getDetections },
  vehicles: { GET: getVehicles },
  trajectory: { GET: getTrajectory },
  'model-status': { GET: getModelStatus },
  'audit-log': { GET: getAuditLog },
};

/**
 * Route name from the request: `?path=` (set by the vercel.json rewrite
 * /api/data/:path* → /api/data?path=:path*) or the URL path after /api/data/.
 */
export function routeName(url: URL): string {
  const fromQuery = url.searchParams.get('path');
  const raw = fromQuery ?? url.pathname.replace(/^\/api\/data\/?/, '');
  return raw.replace(/^\/+|\/+$/g, '').toLowerCase();
}

export async function handleData(request: Request, deps: DataDeps = {}): Promise<Response> {
  const url = new URL(request.url);
  const route = ROUTES[routeName(url)];
  if (!route) return errorResponse(404, 'Unknown data route');

  const method = request.method.toUpperCase();
  const allow = Object.keys(route).join(', ');
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: { Allow: allow } });
  const fn = route[(method === 'HEAD' ? 'GET' : method) as 'GET' | 'POST' | 'PATCH'];
  if (!fn) return errorResponse(405, `Method not allowed — use ${allow}`, { Allow: allow });

  const limiter = method === 'GET' || method === 'HEAD' ? readLimiter : writeLimiter;
  if (limiter.hit(clientIp(request))) return errorResponse(429, 'Too many requests — slow down', { 'Retry-After': '60' });

  const cfg = readAdminConfig(deps.env ?? process.env);
  if (!cfg) return errorResponse(503, 'Data API is not configured on this server (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');

  const ctx: Ctx = { request, url, db: new SupabaseAdmin(cfg, deps.fetch ?? fetch), now: deps.now ?? Date.now };
  try {
    return await fn(ctx);
  } catch (err) {
    if (err instanceof ApiError) return errorResponse(err.status, err.message);
    if (err instanceof UpstreamError) {
      // Client-caused database errors (bad filter/constraint) are 400s; the rest are 502.
      const status = err.code === '23505' ? 409 : err.status >= 400 && err.status < 500 ? 400 : 502;
      const msg = err.code === '23505' ? 'That record already exists' : err.message;
      return errorResponse(status, msg);
    }
    return errorResponse(500, 'Data API failed');
  }
}
