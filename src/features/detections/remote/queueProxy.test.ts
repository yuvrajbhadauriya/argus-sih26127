// @vitest-environment node
// /api/detect and /api/health on the hosted site: no DETECTION_API_* env, so the
// frame goes through the Supabase queue to the worker on the GPU box.
import { describe, expect, it, vi } from 'vitest';
import { handleDetect } from '../../../../api/detect';
import { handleHealth } from '../../../../api/health';
import { createRateLimiter } from '../../../../api/_lib/rateLimit';
import { DEFAULT_QUERY } from '../../../../api/_lib/modelAdapter';
import { MAX_QUEUE_IMAGE_BYTES } from '../../../../api/_lib/detectQueue';
import { fakeJpeg, fakePng, toB64 } from './testFrames';
import lpuFrame from './fixtures/lpu_frame_vp01.json';

const SB = 'https://proj.supabase.co';
const SERVICE_KEY = 'service-role-key-secret-xyz';
const ENV = { SUPABASE_URL: SB, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY };

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const reply = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * A scripted PostgREST: `enqueue` answers the enqueue RPC, `polls` are the job
 * rows returned by successive GETs (the last one repeats), PATCHes are recorded.
 */
function fakeSupabase(script: {
  enqueue?: () => Response;
  polls?: unknown[][];
  rpc?: Record<string, () => Response>;
}) {
  const calls: Call[] = [];
  let poll = 0;
  const fn = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ method, url, headers, body });
    if (url.includes('/rest/v1/rpc/enqueue_detect_job')) return (script.enqueue ?? (() => reply(200, 'job-1')))();
    const m = /\/rest\/v1\/rpc\/(\w+)/.exec(url);
    if (m && script.rpc?.[m[1]]) return script.rpc[m[1]]();
    if (url.includes('/rest/v1/detect_jobs') && method === 'GET') {
      const polls = script.polls ?? [[{ status: 'done', result: lpuFrame, error: null }]];
      return reply(200, polls[Math.min(poll++, polls.length - 1)]);
    }
    if (url.includes('/rest/v1/detect_jobs') && method === 'PATCH') return reply(200, [{}]);
    return reply(404, { code: 'PGRST125', message: 'unexpected call in test' });
  });
  return { fn, calls };
}

/** Fake clock: sleeping advances time, so a timeout test takes no real time. */
function fakeClock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

function jsonRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/detect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.9', ...headers },
    body: JSON.stringify(body),
  });
}

const frameBody = (jpeg = fakeJpeg(1280, 720)) => ({ image_base64: toB64(jpeg), camera_code: 'SC-01', frame_timestamp_sec: 12.5 });

async function expectNoSecrets(res: Response) {
  const text = await res.clone().text();
  expect(text).not.toContain(SERVICE_KEY);
  expect(text).not.toContain(SB);
  for (const [, v] of res.headers) expect(v).not.toContain(SERVICE_KEY);
  return text;
}

describe('POST /api/detect — queued through Supabase (hosted site)', () => {
  it('enqueues the frame, waits for the worker and returns the same contract as the direct path', async () => {
    const sb = fakeSupabase({
      polls: [[{ status: 'pending', result: null, error: null }], [{ status: 'processing', result: null, error: null }], [{ status: 'done', result: lpuFrame, error: null }]],
    });
    const clock = fakeClock();
    const jpeg = fakeJpeg(1920, 1080);
    const res = await handleDetect(jsonRequest(frameBody(jpeg)), { env: ENV, fetch: sb.fn, queue: clock });
    expect(res.status).toBe(200);
    await expectNoSecrets(res);
    const body = await res.json();

    // Same mapping as the direct path (modelAdapter) for the same model answer.
    const direct = await handleDetect(jsonRequest(frameBody(jpeg)), {
      env: { DETECTION_API_URL: 'http://10.0.0.7:8765/v1/frame', DETECTION_API_KEY: 'k' },
      fetch: vi.fn<typeof fetch>(async () => reply(200, lpuFrame)),
    });
    const directBody = await direct.json();
    expect({ ...body, latency_ms: 0 }).toEqual({ ...directBody, latency_ms: 0 });
    expect(body.detections.length).toBeGreaterThan(0);
    expect(typeof body.latency_ms).toBe('number');

    // What went to the database: the frame, the camera and the default query, with the service key.
    const enqueue = sb.calls.find((c) => c.url.endsWith('/rest/v1/rpc/enqueue_detect_job'))!;
    expect(enqueue.method).toBe('POST');
    expect(enqueue.body).toEqual({
      p_camera_code: 'SC-01',
      p_query: DEFAULT_QUERY,
      p_width: 1920,
      p_height: 1080,
      p_frame_b64: toB64(jpeg),
    });
    expect(enqueue.headers.apikey).toBe(SERVICE_KEY);
    expect(enqueue.headers.Authorization).toBe(`Bearer ${SERVICE_KEY}`);
    // It looked at the job row until the worker finished (3 looks), always by id.
    const looks = sb.calls.filter((c) => c.method === 'GET');
    expect(looks).toHaveLength(3);
    expect(looks[0].url).toContain('id=eq.job-1');
  });

  it('sends DETECTION_API_QUERY to the worker when it is set', async () => {
    const sb = fakeSupabase({});
    await handleDetect(jsonRequest(frameBody()), { env: { ...ENV, DETECTION_API_QUERY: '?tiles=3x3&min_conf=70' }, fetch: sb.fn, queue: fakeClock() });
    const enqueue = sb.calls.find((c) => c.url.endsWith('/rest/v1/rpc/enqueue_detect_job'))!;
    expect((enqueue.body as { p_query: string }).p_query).toBe('tiles=3x3&min_conf=70');
  });

  it('prefers the direct model API when DETECTION_API_URL and the key are set (local dev)', async () => {
    const sb = fakeSupabase({});
    const upstream = vi.fn<typeof fetch>(async () => reply(200, lpuFrame));
    const res = await handleDetect(jsonRequest(frameBody()), {
      env: { ...ENV, DETECTION_API_URL: 'http://10.0.0.7:8765/v1/frame', DETECTION_API_KEY: 'k' },
      fetch: upstream,
    });
    expect(res.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(String(upstream.mock.calls[0][0])).toContain('10.0.0.7:8765/v1/frame');
    expect(sb.fn).not.toHaveBeenCalled();
  });

  it('answers 503 (permanent for the client) when no worker is alive', async () => {
    const sb = fakeSupabase({ enqueue: () => reply(503, { code: 'PT503', message: 'GPU worker is offline', details: null, hint: null }) });
    const res = await handleDetect(jsonRequest(frameBody()), { env: ENV, fetch: sb.fn, queue: fakeClock() });
    expect(res.status).toBe(503);
    await expectNoSecrets(res);
    expect((await res.json()).error).toMatch(/GPU worker is offline/);
    expect(sb.calls.filter((c) => c.method === 'GET')).toHaveLength(0);
  });

  it('answers 429 with Retry-After when too many frames are waiting', async () => {
    const sb = fakeSupabase({ enqueue: () => reply(429, { code: 'PT429', message: 'Too many frames waiting' }) });
    const res = await handleDetect(jsonRequest(frameBody()), { env: ENV, fetch: sb.fn, queue: fakeClock() });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('2');
  });

  it('answers 503 "not set up" while the migration has not been applied', async () => {
    const sb = fakeSupabase({ enqueue: () => reply(404, { code: 'PGRST202', message: 'Could not find the function public.enqueue_detect_job' }) });
    const res = await handleDetect(jsonRequest(frameBody()), { env: ENV, fetch: sb.fn, queue: fakeClock() });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/not set up/);
  });

  it('turns a failed job into 502 with the worker\'s short reason', async () => {
    const sb = fakeSupabase({ polls: [[{ status: 'pending', result: null, error: null }], [{ status: 'error', result: null, error: 'Detection model API returned HTTP 500' }]] });
    const res = await handleDetect(jsonRequest(frameBody()), { env: ENV, fetch: sb.fn, queue: fakeClock() });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('Detection model API returned HTTP 500');
  });

  it('times out with 504 after the wait budget and gives the frame up', async () => {
    const sb = fakeSupabase({ polls: [[{ status: 'pending', result: null, error: null }]] });
    const clock = fakeClock();
    const res = await handleDetect(jsonRequest(frameBody()), { env: ENV, fetch: sb.fn, queue: { ...clock, waitMs: 2000 } });
    expect(res.status).toBe(504);
    const patch = sb.calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toContain('detect_jobs');
    expect(patch.url).toContain('id=eq.job-1');
    expect(patch.body).toEqual({ status: 'error', error: 'timed out', frame_b64: null });
    // 2 s budget at a 150 ms rhythm is a bounded number of looks, not a busy loop.
    const looks = sb.calls.filter((c) => c.method === 'GET').length;
    expect(looks).toBeGreaterThan(5);
    expect(looks).toBeLessThan(20);
  });

  it('answers 502 when Supabase itself cannot be reached', async () => {
    const fn = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    const res = await handleDetect(jsonRequest(frameBody()), { env: ENV, fetch: fn, queue: fakeClock() });
    expect(res.status).toBe(502);
    await expectNoSecrets(res);
  });

  it('rejects PNG (415) and oversized frames (413) before touching the database', async () => {
    const sb = fakeSupabase({});
    const png = await handleDetect(jsonRequest({ image_base64: toB64(fakePng()) }), { env: ENV, fetch: sb.fn });
    expect(png.status).toBe(415);
    const big = await handleDetect(jsonRequest({ image_base64: toB64(fakeJpeg(1920, 1080, MAX_QUEUE_IMAGE_BYTES + 10)) }), { env: ENV, fetch: sb.fn });
    expect(big.status).toBe(413);
    expect(sb.fn).not.toHaveBeenCalled();
  });

  it('rate-limits one address (429) without touching the database', async () => {
    const sb = fakeSupabase({});
    const limiter = createRateLimiter({ windowMs: 10_000, max: 1 });
    const first = await handleDetect(jsonRequest(frameBody()), { env: ENV, fetch: sb.fn, limiter, queue: fakeClock() });
    expect(first.status).toBe(200);
    const callsAfterFirst = sb.fn.mock.calls.length;
    const second = await handleDetect(jsonRequest(frameBody()), { env: ENV, fetch: sb.fn, limiter, queue: fakeClock() });
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBe('5');
    expect(sb.fn.mock.calls.length).toBe(callsAfterFirst);
    // another address is not affected
    const other = await handleDetect(jsonRequest(frameBody(), { 'x-forwarded-for': '198.51.100.4' }), { env: ENV, fetch: sb.fn, limiter, queue: fakeClock() });
    expect(other.status).toBe(200);
  });

  it('still answers 503 "not configured" with neither the model API nor Supabase', async () => {
    const res = await handleDetect(jsonRequest(frameBody()), { env: {} });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/LAN\/VPN-only/);
  });
});

describe('GET /api/health — queued (hosted site)', () => {
  const get = () => new Request('http://localhost/api/health');

  it('is healthy when the GPU worker has checked in', async () => {
    const sb = fakeSupabase({ rpc: { detect_worker_status: () => reply(200, [{ online: true, version: 'w1', seen_seconds_ago: 4.2, jobs_done: 17 }]) } });
    const res = await handleHealth(get(), { env: ENV, fetch: sb.fn });
    expect(res.status).toBe(200);
    await expectNoSecrets(res);
    expect(await res.json()).toMatchObject({ ok: true, configured: true, reachable: true, model_ok: true, via: 'queue', worker_version: 'w1', worker_seen_seconds_ago: 4.2 });
  });

  it('is 503 when the worker went quiet or never registered', async () => {
    for (const rows of [[{ online: false, version: 'w1', seen_seconds_ago: 90, jobs_done: 3 }], []]) {
      const sb = fakeSupabase({ rpc: { detect_worker_status: () => reply(200, rows) } });
      const res = await handleHealth(get(), { env: ENV, fetch: sb.fn });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ ok: false, configured: true, reachable: false, via: 'queue' });
    }
  });

  it('is 502 when the queue cannot be read, and never leaks the key', async () => {
    const fn = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    const res = await handleHealth(get(), { env: ENV, fetch: fn });
    expect(res.status).toBe(502);
    await expectNoSecrets(res);
  });

  it('keeps the old "not configured" answer with neither the model API nor Supabase', async () => {
    const res = await handleHealth(get(), { env: {} });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ configured: false });
  });
});
