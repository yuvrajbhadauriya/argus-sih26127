import { describe, expect, it, vi } from 'vitest';
import { FAILURE_RETRY_MS, MAX_PATHS_PER_CALL, REFRESH_MARGIN_MS, SignedUrlCache } from './signedUrls';

function signer(expiresIn = 3600, missing: string[] = []) {
  return vi.fn<typeof fetch>(async (input) => {
    const u = new URL(String(input), 'http://x');
    const paths = (u.searchParams.get('paths') ?? '').split(',');
    const urls = Object.fromEntries(paths.filter((p) => !missing.includes(p)).map((p) => [p, `https://cdn/${p}?token=t`]));
    return new Response(JSON.stringify({ urls, expires_in: expiresIn }), { status: 200 });
  });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('SignedUrlCache', () => {
  it('batches requests from one tick into calls of at most 60 paths', async () => {
    const f = signer();
    const c = new SignedUrlCache('golden', { fetch: f });
    const paths = Array.from({ length: 70 }, (_, i) => `ocr_golden_v1/${i}.jpg`);
    c.request(paths.slice(0, 30));
    c.request(paths.slice(30));
    c.request(paths.slice(0, 5)); // duplicates are ignored
    expect(c.peek(paths[0])).toBeUndefined();
    await flush();
    await flush();
    expect(f).toHaveBeenCalledTimes(2);
    const sizes = f.mock.calls.map(([u]) => new URL(String(u), 'http://x').searchParams.get('paths')!.split(',').length);
    expect(sizes.sort((a, b) => b - a)).toEqual([MAX_PATHS_PER_CALL, 10]);
    expect(new URL(String(f.mock.calls[0][0]), 'http://x').searchParams.get('bucket')).toBe('golden');
    expect(c.peek(paths[69])).toBe('https://cdn/ocr_golden_v1/69.jpg?token=t');
  });

  it('serves from memory until 5 minutes before expiry, then re-signs', async () => {
    let now = 0;
    const f = signer(3600);
    const c = new SignedUrlCache('golden', { fetch: f, now: () => now });
    c.request(['ocr_golden_v1/a.jpg']);
    await flush();
    c.request(['ocr_golden_v1/a.jpg']);
    await flush();
    expect(f).toHaveBeenCalledTimes(1);
    now = 3600_000 - REFRESH_MARGIN_MS - 1;
    expect(c.peek('ocr_golden_v1/a.jpg')).toMatch(/^https:/);
    now = 3600_000 - REFRESH_MARGIN_MS + 1;
    expect(c.peek('ocr_golden_v1/a.jpg')).toBeUndefined();
    c.request(['ocr_golden_v1/a.jpg']);
    await flush();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('marks failures (HTTP error, network error, missing path) as unavailable, retrying later', async () => {
    let now = 0;
    const down = vi.fn<typeof fetch>(async () => new Response('{}', { status: 502 }));
    const c = new SignedUrlCache('golden', { fetch: down, now: () => now });
    const listener = vi.fn();
    c.subscribe(listener);
    c.request(['ocr_golden_v1/a.jpg']);
    await flush();
    expect(c.peek('ocr_golden_v1/a.jpg')).toBeNull();
    expect(listener).toHaveBeenCalled();
    c.request(['ocr_golden_v1/a.jpg']);
    await flush();
    expect(down).toHaveBeenCalledTimes(1); // no retry loop
    now = FAILURE_RETRY_MS + 1;
    expect(c.peek('ocr_golden_v1/a.jpg')).toBeUndefined();

    const throws = new SignedUrlCache('golden', { fetch: vi.fn<typeof fetch>(async () => Promise.reject(new TypeError('offline'))) });
    throws.request(['ocr_golden_v1/b.jpg']);
    await flush();
    expect(throws.peek('ocr_golden_v1/b.jpg')).toBeNull();

    const partial = new SignedUrlCache('golden', { fetch: signer(3600, ['ocr_golden_v1/gone.jpg']) });
    partial.request(['ocr_golden_v1/ok.jpg', 'ocr_golden_v1/gone.jpg']);
    await flush();
    expect(partial.peek('ocr_golden_v1/ok.jpg')).toMatch(/^https:/);
    expect(partial.peek('ocr_golden_v1/gone.jpg')).toBeNull();
  });

  it('markBroken shows the placeholder instead of re-signing immediately', async () => {
    const f = signer();
    const c = new SignedUrlCache('golden', { fetch: f });
    c.request(['ocr_golden_v1/a.jpg']);
    await flush();
    c.markBroken('ocr_golden_v1/a.jpg');
    expect(c.peek('ocr_golden_v1/a.jpg')).toBeNull();
    c.request(['ocr_golden_v1/a.jpg']);
    await flush();
    expect(f).toHaveBeenCalledTimes(1);
  });
});
