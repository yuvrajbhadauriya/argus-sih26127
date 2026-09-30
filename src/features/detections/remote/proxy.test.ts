// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { handleDetect } from '../../../../api/detect';
import { handleHealth } from '../../../../api/health';
import { MAX_IMAGE_BYTES } from '../../../../api/_lib/http';
import { fakeJpeg, fakePng, toB64 } from './testFrames';

const KEY = 'super-secret-model-key-123';
const UPSTREAM = 'http://10.0.0.7:8000/v1/detect';
const ENV = { DETECTION_API_URL: UPSTREAM, DETECTION_API_KEY: KEY };

const UPSTREAM_BODY = {
  model: 'yolov7-tiny-anpr',
  version: '2026.09',
  predictions: [{ class: 'car', confidence: 0.94, xyxy: [100, 50, 300, 200], plate: { text: 'MH 01 AB 1234', confidence: 0.99 } }],
};

function upstreamOk(body: unknown = UPSTREAM_BODY) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
}

function jsonRequest(body: unknown, init: RequestInit = {}) {
  return new Request('http://localhost/api/detect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  });
}

async function expectNoSecrets(res: Response) {
  const text = await res.clone().text();
  expect(text).not.toContain(KEY);
  expect(text).not.toContain(UPSTREAM);
  expect(text).not.toContain('10.0.0.7');
  for (const [, v] of res.headers) {
    expect(v).not.toContain(KEY);
  }
  return text;
}

describe('POST /api/detect', () => {
  it('forwards a JSON frame with the bearer key and returns the normalised contract', async () => {
    const fetchMock = upstreamOk();
    const res = await handleDetect(
      jsonRequest({ image_base64: toB64(fakeJpeg(640, 360)), camera_code: 'JG-01', frame_timestamp_sec: 3.2 }),
      { env: ENV, fetch: fetchMock },
    );
    expect(res.status).toBe(200);
    await expectNoSecrets(res);
    const body = await res.json();
    expect(body).toMatchObject({
      engine: 'yolov7-tiny-anpr',
      model_version: '2026.09',
      image: { width: 640, height: 360 },
      detections: [
        { plate_text: 'MH 01 AB 1234', plate_confidence: 0.99, vehicle_type: 'car', confidence: 0.94, bbox: { x: 100, y: 50, width: 200, height: 150 } },
      ],
    });
    expect(typeof body.latency_ms).toBe('number');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(UPSTREAM);
    expect((init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    const form = init!.body as FormData;
    expect(form.get('camera_code')).toBe('JG-01');
    expect(form.get('frame_timestamp_sec')).toBe('3.2');
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });

  it('accepts multipart uploads and a custom raw-key header', async () => {
    const fetchMock = upstreamOk({ results: [] });
    const form = new FormData();
    form.append('image', new Blob([fakePng() as BlobPart], { type: 'image/png' }), 'f.png');
    form.append('camera_code', 'AN-01');
    const res = await handleDetect(new Request('http://localhost/api/detect', { method: 'POST', body: form }), {
      env: { ...ENV, DETECTION_API_AUTH_HEADER: 'x-api-key' },
      fetch: fetchMock,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).detections).toEqual([]);
    const headers = fetchMock.mock.calls[0][1]!.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(KEY);
    expect(headers.Authorization).toBeUndefined();
  });

  it('503 when the model API is not configured', async () => {
    const fetchMock = upstreamOk();
    const res = await handleDetect(jsonRequest({ image_base64: toB64(fakeJpeg()) }), { env: {}, fetch: fetchMock });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('405 for non-POST methods', async () => {
    const res = await handleDetect(new Request('http://localhost/api/detect'), { env: ENV, fetch: upstreamOk() });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toContain('POST');
  });

  it.each([
    ['missing image', { camera_code: 'JG-01' }],
    ['not an image', { image_base64: toB64(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])) }],
    ['invalid base64', { image_base64: '***' }],
  ])('400 for %s', async (_name, payload) => {
    const fetchMock = upstreamOk();
    const res = await handleDetect(jsonRequest(payload), { env: ENV, fetch: fetchMock });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('400 for malformed JSON and 415 for other content types', async () => {
    const bad = new Request('http://localhost/api/detect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    expect((await handleDetect(bad, { env: ENV, fetch: upstreamOk() })).status).toBe(400);
    const text = new Request('http://localhost/api/detect', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'hi' });
    expect((await handleDetect(text, { env: ENV, fetch: upstreamOk() })).status).toBe(415);
  });

  it('413 for oversize frames', async () => {
    const fetchMock = upstreamOk();
    const big = fakeJpeg(640, 360, MAX_IMAGE_BYTES + 10);
    const res = await handleDetect(jsonRequest({ image_base64: toB64(big) }), { env: ENV, fetch: fetchMock });
    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();

    const declared = new Request('http://localhost/api/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(20 * 1024 * 1024) },
      body: '{}',
    });
    expect((await handleDetect(declared, { env: ENV, fetch: fetchMock })).status).toBe(413);
  });

  it('504 when the upstream exceeds DETECTION_API_TIMEOUT_MS', async () => {
    const hanging = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const res = await handleDetect(jsonRequest({ image_base64: toB64(fakeJpeg()) }), {
      env: { ...ENV, DETECTION_API_TIMEOUT_MS: '20' },
      fetch: hanging,
    });
    expect(res.status).toBe(504);
    expect((await res.json()).error).toMatch(/timed out/);
  });

  it('502 when the upstream is unreachable, errors, or returns an unknown shape — without leaking secrets', async () => {
    const down = vi.fn<typeof fetch>(async () => {
      throw new TypeError(`fetch failed: connect ECONNREFUSED ${UPSTREAM} key=${KEY}`);
    });
    let res = await handleDetect(jsonRequest({ image_base64: toB64(fakeJpeg()) }), { env: ENV, fetch: down });
    expect(res.status).toBe(502);
    await expectNoSecrets(res);

    const unauthorised = vi.fn<typeof fetch>(async () => new Response(`bad key ${KEY}`, { status: 401 }));
    res = await handleDetect(jsonRequest({ image_base64: toB64(fakeJpeg()) }), { env: ENV, fetch: unauthorised });
    expect(res.status).toBe(502);
    expect((await expectNoSecrets(res))).toMatch(/401/);

    const html = vi.fn<typeof fetch>(async () => new Response('<html>', { status: 200 }));
    res = await handleDetect(jsonRequest({ image_base64: toB64(fakeJpeg()) }), { env: ENV, fetch: html });
    expect(res.status).toBe(502);

    res = await handleDetect(jsonRequest({ image_base64: toB64(fakeJpeg()) }), { env: ENV, fetch: upstreamOk({ echo: KEY }) });
    expect(res.status).toBe(502);
    await expectNoSecrets(res);
  });

  it('never echoes the key even if the upstream response contains it', async () => {
    const res = await handleDetect(jsonRequest({ image_base64: toB64(fakeJpeg()) }), {
      env: ENV,
      fetch: upstreamOk({ api_key: KEY, url: UPSTREAM, detections: [] }),
    });
    expect(res.status).toBe(200);
    await expectNoSecrets(res);
  });
});

describe('GET /api/health', () => {
  it('reports unconfigured without probing', async () => {
    const fetchMock = upstreamOk();
    const res = await handleHealth(new Request('http://localhost/api/health'), { env: {}, fetch: fetchMock });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, configured: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('probes <origin>/health with the key and hides secrets', async () => {
    const fetchMock = upstreamOk({ status: 'ok' });
    const res = await handleHealth(new Request('http://localhost/api/health'), { env: ENV, fetch: fetchMock });
    expect(res.status).toBe(200);
    expect(await res.clone().json()).toMatchObject({ ok: true, configured: true, reachable: true, model_ok: true, upstream_status: 200 });
    await expectNoSecrets(res);
    expect(fetchMock.mock.calls[0][0]).toBe('http://10.0.0.7:8000/health');
  });

  it('reports unreachable', async () => {
    const down = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    const res = await handleHealth(new Request('http://localhost/api/health'), { env: ENV, fetch: down });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ configured: true, reachable: false });
  });
});
