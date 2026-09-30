// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleSign, MAX_PATHS, RATE_LIMIT, rateLimited, resetRateLimit, validateSignRequest } from '../../../api/media/sign';

const KEY = 'service-role-secret-xyz';
const ENV = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: KEY };

function req(qs: string, init: RequestInit & { ip?: string } = {}) {
  return new Request(`http://localhost/api/media/sign?${qs}`, { method: init.method ?? 'GET', headers: { 'x-forwarded-for': init.ip ?? '203.0.113.9' } });
}

function upstream(rows: unknown, status = 200) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(rows), { status, headers: { 'Content-Type': 'application/json' } }));
}

beforeEach(() => resetRateLimit());

describe('validateSignRequest', () => {
  it('only allows the allowlisted bucket/prefix pairs', () => {
    expect(validateSignRequest('golden', ['ocr_golden_v1/a.jpg'])).toEqual({ bucket: 'golden', paths: ['ocr_golden_v1/a.jpg'] });
    expect(validateSignRequest('videos', ['mumbai/720p/vp01.mp4,mumbai/720p/vp01.jpg'])).toMatchObject({ paths: ['mumbai/720p/vp01.mp4', 'mumbai/720p/vp01.jpg'] });
    expect(validateSignRequest('private', ['ocr_golden_v1/a.jpg'])).toEqual({ error: 'bucket not allowed' });
    expect(validateSignRequest(null, ['x'])).toEqual({ error: 'bucket not allowed' });
    expect(validateSignRequest('golden', ['mumbai/720p/vp01.mp4'])).toEqual({ error: 'path not allowed' });
    expect(validateSignRequest('golden', ['ocr_golden_v1/../secret.jpg'])).toEqual({ error: 'path not allowed' });
    expect(validateSignRequest('golden', ['ocr_golden_v1/'])).toEqual({ error: 'path not allowed' });
    expect(validateSignRequest('golden', ['/ocr_golden_v1/a.jpg'])).toEqual({ error: 'path not allowed' });
    expect(validateSignRequest('golden', [])).toEqual({ error: 'paths is required' });
    expect(validateSignRequest('__proto__', ['a'])).toEqual({ error: 'bucket not allowed' });
  });
});

describe('GET /api/media/sign', () => {
  it('rejects a bucket or path outside the allowlist with 400 and never calls storage', async () => {
    const f = upstream([]);
    const r1 = await handleSign(req('bucket=avatars&paths=ocr_golden_v1/a.jpg'), { env: ENV, fetch: f });
    const r2 = await handleSign(req('bucket=golden&paths=other/a.jpg'), { env: ENV, fetch: f });
    expect(r1.status).toBe(400);
    expect(r2.status).toBe(400);
    expect(f).not.toHaveBeenCalled();
  });

  it('rejects more than MAX_PATHS paths', async () => {
    const paths = Array.from({ length: MAX_PATHS + 1 }, (_, i) => `ocr_golden_v1/${i}.jpg`).join(',');
    const res = await handleSign(req(`bucket=golden&paths=${paths}`), { env: ENV, fetch: upstream([]) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: `too many paths (max ${MAX_PATHS})` });
  });

  it('signs via storage with the service key and returns absolute URLs, not the key', async () => {
    const f = upstream([
      { path: 'ocr_golden_v1/a.jpg', signedURL: '/object/sign/golden/ocr_golden_v1/a.jpg?token=t1', error: null },
      { path: 'ocr_golden_v1/b.jpg', signedURL: null, error: 'Either the object does not exist or you do not have access to it' },
    ]);
    const res = await handleSign(req('bucket=golden&paths=ocr_golden_v1/a.jpg&paths=ocr_golden_v1/b.jpg'), { env: ENV, fetch: f });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
    const text = await res.text();
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text)).toEqual({
      urls: { 'ocr_golden_v1/a.jpg': 'https://proj.supabase.co/storage/v1/object/sign/golden/ocr_golden_v1/a.jpg?token=t1' },
      expires_in: 3600,
    });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://proj.supabase.co/storage/v1/object/sign/golden');
    expect((init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(init!.body))).toEqual({ expiresIn: 3600, paths: ['ocr_golden_v1/a.jpg', 'ocr_golden_v1/b.jpg'] });
  });

  it('maps storage failures to 502 and missing config to 503', async () => {
    expect((await handleSign(req('bucket=golden&paths=ocr_golden_v1/a.jpg'), { env: ENV, fetch: upstream({ error: 'x' }, 500) })).status).toBe(502);
    const down = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    expect((await handleSign(req('bucket=golden&paths=ocr_golden_v1/a.jpg'), { env: ENV, fetch: down })).status).toBe(502);
    expect((await handleSign(req('bucket=golden&paths=ocr_golden_v1/a.jpg'), { env: {}, fetch: upstream([]) })).status).toBe(503);
  });

  it('only answers GET', async () => {
    expect((await handleSign(req('bucket=golden&paths=ocr_golden_v1/a.jpg', { method: 'POST' }), { env: ENV })).status).toBe(405);
  });

  it('rate-limits per IP', async () => {
    const now = 1_000_000;
    for (let i = 0; i < RATE_LIMIT.max; i++) expect(rateLimited('198.51.100.1', now)).toBe(false);
    expect(rateLimited('198.51.100.1', now)).toBe(true);
    expect(rateLimited('198.51.100.2', now)).toBe(false);
    expect(rateLimited('198.51.100.1', now + RATE_LIMIT.windowMs)).toBe(false);
    const res = await handleSign(req('bucket=golden&paths=ocr_golden_v1/a.jpg', { ip: '198.51.100.1' }), { env: ENV, fetch: upstream([]), now: now + 1 });
    expect(res.status).toBe(200); // new window started above
  });
});

