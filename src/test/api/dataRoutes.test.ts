// @vitest-environment node
// /api/data/* (api/_lib/dataRoutes.ts) with a mocked Supabase (PostgREST + GoTrue).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALERT_EMBED_SELECT,
  CACHE,
  handleData,
  READ_LIMIT,
  resetDataRateLimits,
  routeName,
  WRITE_LIMIT,
} from '../../../api/_lib/dataRoutes';
import { matchRoute, pickServerEnv } from '../../../api/_lib/viteDevBridge';
import { createRateLimiter } from '../../../api/_lib/rateLimit';

const SB = 'https://proj.supabase.co';
const SERVICE_KEY = 'service-role-secret-key-xyz';
const ENV = { SUPABASE_URL: SB, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY };
const OP_TOKEN = 'op-access-token';
const VIEWER_TOKEN = 'viewer-access-token';

interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

type Reply = { status?: number; body: unknown };
type Responder = (call: Call) => Reply | undefined;

function mockSupabase(respond: Responder) {
  const calls: Call[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    const call: Call = { method: (init?.method ?? 'GET').toUpperCase(), url, headers, body };
    calls.push(call);
    if (url.pathname === '/auth/v1/user') {
      const auth = headers.get('authorization');
      if (auth === `Bearer ${OP_TOKEN}`) return Response.json({ id: 'uid-op', email: 'op@nero.in', app_metadata: { role: 'operator' } });
      if (auth === `Bearer ${VIEWER_TOKEN}`) return Response.json({ id: 'uid-v', email: 'v@nero.in', app_metadata: {} });
      return Response.json({ msg: 'invalid JWT' }, { status: 401 });
    }
    const r = respond(call) ?? { body: [] };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  });
  return { fetch: fetchMock, calls, rest: () => calls.filter((c) => c.url.pathname.startsWith('/rest/v1/')) };
}

function req(path: string, init: RequestInit & { token?: string; ip?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('Authorization', `Bearer ${init.token}`);
  if (init.body) headers.set('Content-Type', 'application/json');
  headers.set('x-forwarded-for', init.ip ?? '203.0.113.9');
  return new Request(`http://localhost${path}`, { ...init, headers });
}

async function expectNoSecrets(res: Response) {
  const text = await res.clone().text();
  expect(text).not.toContain(SERVICE_KEY);
  expect(text).not.toContain(SB);
}

beforeEach(() => resetDataRateLimits());
afterEach(() => vi.restoreAllMocks());

describe('routing', () => {
  it('reads the route from ?path= (vercel rewrite) or the URL path', () => {
    expect(routeName(new URL('http://x/api/data?path=alerts/acknowledge&id=1'))).toBe('alerts/acknowledge');
    expect(routeName(new URL('http://x/api/data/cameras/'))).toBe('cameras');
  });

  it('404s unknown routes and 405s wrong methods', async () => {
    const sb = mockSupabase(() => undefined);
    expect((await handleData(req('/api/data/nope'), { env: ENV, fetch: sb.fetch })).status).toBe(404);
    const res = await handleData(req('/api/data/alerts', { method: 'DELETE' }), { env: ENV, fetch: sb.fetch });
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET');
    expect(sb.calls).toHaveLength(0);
  });

  it('503s without server env and never leaks it', async () => {
    const res = await handleData(req('/api/data/cameras'), { env: {} });
    expect(res.status).toBe(503);
  });

  it('dev bridge maps every /api/data/<route> to the data handler and passes only server keys', () => {
    expect(matchRoute('/api/data/alerts/acknowledge')?.handler).toBe('handleData');
    expect(matchRoute('/api/data')?.handler).toBe('handleData');
    expect(matchRoute('/api/other')).toBeUndefined();
    expect(pickServerEnv({ ...ENV, VITE_SUPABASE_ANON_KEY: 'a', SUPABASE_DB_PASSWORD: 'pw', HOME: '/h' })).toEqual(ENV);
  });
});

describe('public reads', () => {
  it('GET cameras: service key upstream, column-limited, CDN-cacheable, no secrets out', async () => {
    const sb = mockSupabase(() => ({ body: [{ id: 'cam-vp-01', code: 'VP-01' }] }));
    const res = await handleData(req('/api/data?path=cameras'), { env: ENV, fetch: sb.fetch });
    expect(res.status).toBe(200);
    await expectNoSecrets(res);
    expect(await res.json()).toEqual({ rows: [{ id: 'cam-vp-01', code: 'VP-01' }] });
    expect(res.headers.get('Cache-Control')).toBe(CACHE.registry);
    const [call] = sb.rest();
    expect(call.url.pathname).toBe('/rest/v1/cameras');
    expect(call.url.searchParams.get('select')).not.toContain('*');
    expect(call.url.searchParams.get('order')).toBe('code.asc');
    expect(call.headers.get('apikey')).toBe(SERVICE_KEY);
    expect(call.headers.get('authorization')).toBe(`Bearer ${SERVICE_KEY}`);
  });

  it('GET cameras?id= returns one row and validates the id', async () => {
    const sb = mockSupabase(() => ({ body: [{ id: 'cam-1' }] }));
    const res = await handleData(req('/api/data/cameras?id=cam-1'), { env: ENV, fetch: sb.fetch });
    expect(await res.json()).toEqual({ row: { id: 'cam-1' } });
    expect(sb.rest()[0].url.searchParams.get('id')).toBe('eq.cam-1');
    const bad = await handleData(req('/api/data/cameras?id=a,b)or(1'), { env: ENV, fetch: sb.fetch });
    expect(bad.status).toBe(400);
  });

  it('GET alerts embeds detection/camera/watchlist and falls back to a plain select on a schema error', async () => {
    const sb = mockSupabase((c) =>
      c.url.searchParams.get('select') === ALERT_EMBED_SELECT ? { status: 400, body: { code: 'PGRST200', message: 'no relationship' } } : { body: [{ id: 'a1' }] },
    );
    const res = await handleData(req('/api/data/alerts'), { env: ENV, fetch: sb.fetch });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rows: [{ id: 'a1' }] });
    expect(sb.rest().map((c) => c.url.searchParams.get('select'))).toEqual([ALERT_EMBED_SELECT, '*']);
    expect(res.headers.get('Cache-Control')).toBe(CACHE.alerts);
  });

  it('GET alerts?id= returns { row } (null when missing)', async () => {
    const sb = mockSupabase(() => ({ body: [] }));
    const res = await handleData(req('/api/data/alerts?id=a9'), { env: ENV, fetch: sb.fetch });
    expect(await res.json()).toEqual({ row: null });
  });

  it('GET watchlist lists entries newest first', async () => {
    const sb = mockSupabase(() => ({ body: [{ id: 'bl-1' }] }));
    const res = await handleData(req('/api/data/watchlist'), { env: ENV, fetch: sb.fetch });
    expect(await res.json()).toEqual({ rows: [{ id: 'bl-1' }] });
    expect(sb.rest()[0].url.pathname).toBe('/rest/v1/blacklist_entries');
    expect(sb.rest()[0].url.searchParams.get('order')).toBe('created_at.desc');
  });

  it('GET detections pages through PostgREST 1000-row pages in frame order', async () => {
    const page = (n: number) => Array.from({ length: n }, (_, i) => ({ event_id: `e${i}` }));
    let n = 0;
    const sb = mockSupabase(() => ({ body: page(n++ === 0 ? 1000 : 3) }));
    const res = await handleData(req('/api/data/detections?camera_id=cam-vp-01'), { env: ENV, fetch: sb.fetch });
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(1003);
    const calls = sb.rest();
    expect(calls).toHaveLength(2);
    expect(calls[1].url.searchParams.get('offset')).toBe('1000');
    expect(calls[0].url.searchParams.get('camera_id')).toBe('eq.cam-vp-01');
    expect(calls[0].url.searchParams.get('order')).toBe('frame_timestamp_sec.asc,event_id.asc');
    expect(res.headers.get('Cache-Control')).toBe(CACHE.detections);
  });

  it('GET detections requires a camera id', async () => {
    const sb = mockSupabase(() => undefined);
    expect((await handleData(req('/api/data/detections'), { env: ENV, fetch: sb.fetch })).status).toBe(400);
  });

  it('GET vehicles searches the normalised plate (filter-injection safe) or lists recent', async () => {
    const sb = mockSupabase(() => ({ body: [] }));
    await handleData(req('/api/data/vehicles?q=mh 02,or(x)'), { env: ENV, fetch: sb.fetch });
    await handleData(req('/api/data/vehicles'), { env: ENV, fetch: sb.fetch });
    const [search, recent] = sb.rest();
    expect(search.url.searchParams.get('plate_text_normalized')).toBe('ilike.*MH02ORX*');
    expect(recent.url.searchParams.get('order')).toBe('last_seen.desc');
    expect(recent.url.searchParams.get('limit')).toBe('100');
  });

  it('GET trajectory prefers the trajectories view, else returns the plate reads', async () => {
    const withView = mockSupabase((c) => (c.url.pathname.endsWith('/trajectories') ? { body: [{ id: 't1' }] } : undefined));
    const a = await handleData(req('/api/data/trajectory?plate=MH 02 CD 5678'), { env: ENV, fetch: withView.fetch });
    expect(await a.json()).toEqual({ trajectory: { id: 't1' }, detections: [] });
    expect(withView.rest()[0].url.searchParams.get('plate_text_normalized')).toBe('eq.MH02CD5678');

    const noView = mockSupabase((c) => (c.url.pathname.endsWith('/detections') ? { body: [{ camera_id: 'c1' }] } : { body: [] }));
    const b = await handleData(req('/api/data/trajectory?plate=MH02CD5678'), { env: ENV, fetch: noView.fetch });
    expect(await b.json()).toEqual({ trajectory: null, detections: [{ camera_id: 'c1' }] });
    expect((await handleData(req('/api/data/trajectory?plate=--'), { env: ENV, fetch: noView.fetch })).status).toBe(400);
  });

  it('GET model-status returns the engine row with a very short cache', async () => {
    const sb = mockSupabase(() => ({ body: [{ id: 'gpu-primary', state: 'running' }] }));
    const res = await handleData(req('/api/data/model-status'), { env: ENV, fetch: sb.fetch });
    expect(await res.json()).toEqual({ row: { id: 'gpu-primary', state: 'running' } });
    expect(sb.rest()[0].url.searchParams.get('id')).toBe('eq.gpu-primary');
    expect(res.headers.get('Cache-Control')).toBe(CACHE.status);
  });

  it('maps database failures to 502 without upstream details', async () => {
    const sb = mockSupabase(() => ({ status: 500, body: { message: `secret at ${SB}` } }));
    const res = await handleData(req('/api/data/watchlist'), { env: ENV, fetch: sb.fetch });
    expect(res.status).toBe(502);
    await expectNoSecrets(res);
    const down = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    expect((await handleData(req('/api/data/cameras'), { env: ENV, fetch: down })).status).toBe(502);
  });
});

describe('operator-only routes', () => {
  it('GET audit-log needs an operator token and is never cached', async () => {
    const sb = mockSupabase(() => ({ body: [{ id: 'l1' }] }));
    expect((await handleData(req('/api/data/audit-log'), { env: ENV, fetch: sb.fetch })).status).toBe(401);
    expect((await handleData(req('/api/data/audit-log', { token: 'bogus' }), { env: ENV, fetch: sb.fetch })).status).toBe(401);
    expect((await handleData(req('/api/data/audit-log', { token: VIEWER_TOKEN }), { env: ENV, fetch: sb.fetch })).status).toBe(403);
    const ok = await handleData(req('/api/data/audit-log?limit=5', { token: OP_TOKEN }), { env: ENV, fetch: sb.fetch });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('Cache-Control')).toBe('no-store');
    expect(sb.rest()).toHaveLength(1);
    expect(sb.rest()[0].url.searchParams.get('limit')).toBe('5');
  });

  it('POST alerts/acknowledge stamps the verified operator and forwards the actor for the audit trigger', async () => {
    const sb = mockSupabase((c) => (c.method === 'PATCH' ? { body: [{ id: 'a1', status: 'acknowledged' }] } : undefined));
    const res = await handleData(
      req('/api/data/alerts/acknowledge', { method: 'POST', token: OP_TOKEN, body: JSON.stringify({ id: 'a1', acknowledged_by: 'spoof' }) }),
      { env: ENV, fetch: sb.fetch, now: () => Date.parse('2026-09-30T10:00:00Z') },
    );
    expect(res.status).toBe(200);
    const [patch] = sb.rest();
    expect(patch.method).toBe('PATCH');
    expect(patch.url.searchParams.get('id')).toBe('eq.a1');
    expect(patch.body).toEqual({
      status: 'acknowledged',
      acknowledged: true,
      acknowledged_by: 'op@nero.in',
      acknowledged_at: '2026-09-30T10:00:00.000Z',
    });
    expect(patch.headers.get('x-argus-actor-id')).toBe('uid-op');
    expect(patch.headers.get('x-argus-actor-email')).toBe('op@nero.in');
    expect(patch.headers.get('prefer')).toBe('return=representation');
  });

  it('acknowledge: 401 anonymous, 403 viewer, 404 unknown alert, 400 bad body', async () => {
    const sb = mockSupabase(() => ({ body: [] }));
    const post = (token: string | undefined, body: string) =>
      handleData(req('/api/data/alerts/acknowledge', { method: 'POST', token, body }), { env: ENV, fetch: sb.fetch });
    expect((await post(undefined, '{"id":"a1"}')).status).toBe(401);
    expect((await post(VIEWER_TOKEN, '{"id":"a1"}')).status).toBe(403);
    expect((await post(OP_TOKEN, '{"id":"a1"}')).status).toBe(404);
    expect((await post(OP_TOKEN, 'not json')).status).toBe(400);
    expect((await post(OP_TOKEN, '{"id":"bad id!"}')).status).toBe(400);
  });

  it('POST watchlist validates input and records the creator', async () => {
    const sb = mockSupabase((c) => (c.method === 'POST' ? { status: 201, body: [c.body] } : undefined));
    const good = await handleData(
      req('/api/data/watchlist', {
        method: 'POST',
        token: OP_TOKEN,
        body: JSON.stringify({ plate_text: 'mh 02 ab 1234', category: 'stolen', priority: 'critical', reason: 'FIR 12', valid_to: null }),
      }),
      { env: ENV, fetch: sb.fetch },
    );
    expect(good.status).toBe(201);
    const insert = sb.rest()[0];
    expect(insert.body).toMatchObject({ plate_text: 'MH 02 AB 1234', priority: 'critical', notes: 'FIR 12', created_by: 'op@nero.in', source: 'dashboard' });
    expect(insert.headers.get('x-argus-actor-email')).toBe('op@nero.in');

    const bad = await handleData(
      req('/api/data/watchlist', { method: 'POST', token: OP_TOKEN, body: JSON.stringify({ plate_text: 'MH02', category: 'nope', reason: 'x' }) }),
      { env: ENV, fetch: sb.fetch },
    );
    expect(bad.status).toBe(400);
  });

  it('PATCH watchlist only forwards whitelisted fields', async () => {
    const sb = mockSupabase((c) => (c.method === 'PATCH' ? { body: [{ id: 'bl-1' }] } : undefined));
    const res = await handleData(
      req('/api/data/watchlist?id=bl-1', { method: 'PATCH', token: OP_TOKEN, body: JSON.stringify({ is_active: false, reason: 'cleared', id: 'x', source: 'hack' }) }),
      { env: ENV, fetch: sb.fetch, now: () => 0 },
    );
    expect(res.status).toBe(200);
    expect(sb.rest()[0].body).toEqual({ is_active: false, reason: 'cleared', notes: 'cleared', updated_at: '1970-01-01T00:00:00.000Z' });
  });

  it('POST/PATCH cameras mirror lat/lng and require an operator', async () => {
    const sb = mockSupabase((c) => (c.method === 'GET' ? undefined : { body: [{ id: 'cam-tt-01' }] }));
    const body = JSON.stringify({ name: 'T', code: 'TT-01', zone: 'Z', direction: 'N', latitude: 19.1, longitude: 72.9 });
    expect((await handleData(req('/api/data/cameras', { method: 'POST', body }), { env: ENV, fetch: sb.fetch })).status).toBe(401);
    const created = await handleData(req('/api/data/cameras', { method: 'POST', token: OP_TOKEN, body }), { env: ENV, fetch: sb.fetch });
    expect(created.status).toBe(201);
    expect(sb.rest()[0].body).toMatchObject({ id: 'cam-tt-01', lat: 19.1, latitude: 19.1, lng: 72.9, longitude: 72.9, status: 'offline' });

    const patched = await handleData(
      req('/api/data/cameras?id=cam-tt-01', { method: 'PATCH', token: OP_TOKEN, body: JSON.stringify({ latitude: 19.2, code: 'XX' }) }),
      { env: ENV, fetch: sb.fetch, now: () => 0 },
    );
    expect(patched.status).toBe(200);
    expect(sb.rest()[1].body).toEqual({ lat: 19.2, latitude: 19.2, updated_at: '1970-01-01T00:00:00.000Z' });
    const out = await handleData(
      req('/api/data/cameras?id=cam-tt-01', { method: 'PATCH', token: OP_TOKEN, body: JSON.stringify({ latitude: 999 }) }),
      { env: ENV, fetch: sb.fetch },
    );
    expect(out.status).toBe(400);
  });

  it('maps a unique violation to 409', async () => {
    const sb = mockSupabase((c) => (c.method === 'POST' ? { status: 409, body: { code: '23505' } } : undefined));
    const body = JSON.stringify({ name: 'T', code: 'TT-01', zone: 'Z', direction: 'N', latitude: 19.1, longitude: 72.9 });
    const res = await handleData(req('/api/data/cameras', { method: 'POST', token: OP_TOKEN, body }), { env: ENV, fetch: sb.fetch });
    expect(res.status).toBe(409);
  });
});

describe('rate limiting', () => {
  it('limits reads and writes per IP', async () => {
    const sb = mockSupabase(() => ({ body: [] }));
    for (let i = 0; i < READ_LIMIT.max; i++) await handleData(req('/api/data/model-status', { ip: '198.51.100.1' }), { env: ENV, fetch: sb.fetch });
    const limited = await handleData(req('/api/data/model-status', { ip: '198.51.100.1' }), { env: ENV, fetch: sb.fetch });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    expect((await handleData(req('/api/data/model-status', { ip: '198.51.100.2' }), { env: ENV, fetch: sb.fetch })).status).toBe(200);

    for (let i = 0; i < WRITE_LIMIT.max; i++) {
      await handleData(req('/api/data/alerts/acknowledge', { method: 'POST', ip: '198.51.100.3', body: '{}' }), { env: ENV, fetch: sb.fetch });
    }
    const w = await handleData(req('/api/data/alerts/acknowledge', { method: 'POST', ip: '198.51.100.3', body: '{}' }), { env: ENV, fetch: sb.fetch });
    expect(w.status).toBe(429);
  });

  it('windows reset', () => {
    const rl = createRateLimiter({ windowMs: 1000, max: 1 });
    expect(rl.hit('a', 0)).toBe(false);
    expect(rl.hit('a', 10)).toBe(true);
    expect(rl.hit('a', 1000)).toBe(false);
  });
});
