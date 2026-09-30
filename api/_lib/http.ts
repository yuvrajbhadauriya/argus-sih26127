// ═══════════════════════════════════════════════════════════════════════
// Small HTTP helpers shared by the /api functions (Web-standard Request/Response).
// Files under api/_lib are not deployed as routes (leading underscore).
// ═══════════════════════════════════════════════════════════════════════

import type { FrameInput } from './modelAdapter.js';

/** Vercel rejects request bodies above 4.5 MB, so keep decoded frames under 4 MB. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** Upper bound on the raw request body (base64 JSON inflates by ~4/3). */
export const MAX_BODY_BYTES = Math.ceil(MAX_IMAGE_BYTES * 1.4) + 64 * 1024;

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

export function errorResponse(status: number, error: string, extraHeaders: Record<string, string> = {}): Response {
  return json({ error }, status, extraHeaders);
}

/** Detects JPEG / PNG by magic bytes. */
export function sniffImageType(bytes: Uint8Array): 'image/jpeg' | 'image/png' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return 'image/png';
  return null;
}

/** Reads pixel dimensions from a PNG IHDR or JPEG SOFn header. */
export function readImageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const type = sniffImageType(bytes);
  if (type === 'image/png' && bytes.length >= 24) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (type === 'image/jpeg') {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        const height = (bytes[i + 5] << 8) | bytes[i + 6];
        const width = (bytes[i + 7] << 8) | bytes[i + 8];
        return width > 0 && height > 0 ? { width, height } : null;
      }
      i += 2 + len;
    }
  }
  return null;
}

function decodeBase64(input: string): Uint8Array {
  // Accept data URLs ("data:image/jpeg;base64,...") as well as bare base64.
  const comma = input.startsWith('data:') ? input.indexOf(',') : -1;
  const b64 = (comma >= 0 ? input.slice(comma + 1) : input).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(b64)) throw new HttpError(400, 'image_base64 is not valid base64');
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function optionalNumber(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function optionalCode(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, 64);
  return s || null;
}

/**
 * Parses an incoming /api/detect request into a validated frame.
 * Accepts `application/json` ({image_base64, camera_code?, frame_timestamp_sec?})
 * and `multipart/form-data` (file field `image` or `frame`, same optional fields).
 * Throws HttpError(400/413/415) with a client-safe message.
 */
export async function readFrameFromRequest(request: Request): Promise<FrameInput> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new HttpError(413, `Frame too large (max ${MAX_IMAGE_BYTES / (1024 * 1024)} MB)`);
  }
  const contentType = (request.headers.get('content-type') || '').toLowerCase();

  let bytes: Uint8Array;
  let cameraCode: string | null = null;
  let frameTimestampSec: number | null = null;

  if (contentType.startsWith('application/json')) {
    const text = await readLimitedText(request);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new HttpError(400, 'Request body is not valid JSON');
    }
    if (typeof body !== 'object' || body === null) throw new HttpError(400, 'Request body must be a JSON object');
    const b = body as Record<string, unknown>;
    const img = b.image_base64 ?? b.image;
    if (typeof img !== 'string' || !img) throw new HttpError(400, 'Missing "image_base64" (base64-encoded JPEG or PNG)');
    bytes = decodeBase64(img);
    cameraCode = optionalCode(b.camera_code);
    frameTimestampSec = optionalNumber(b.frame_timestamp_sec);
  } else if (contentType.startsWith('multipart/form-data')) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new HttpError(400, 'Could not parse multipart form data');
    }
    const file = form.get('image') ?? form.get('frame') ?? form.get('file');
    if (!file || typeof file === 'string') throw new HttpError(400, 'Missing image file field "image"');
    if (file.size > MAX_IMAGE_BYTES) throw new HttpError(413, `Frame too large (max ${MAX_IMAGE_BYTES / (1024 * 1024)} MB)`);
    bytes = new Uint8Array(await file.arrayBuffer());
    cameraCode = optionalCode(form.get('camera_code'));
    frameTimestampSec = optionalNumber(form.get('frame_timestamp_sec'));
  } else {
    throw new HttpError(415, 'Content-Type must be application/json or multipart/form-data');
  }

  if (bytes.length === 0) throw new HttpError(400, 'Image is empty');
  if (bytes.length > MAX_IMAGE_BYTES) throw new HttpError(413, `Frame too large (max ${MAX_IMAGE_BYTES / (1024 * 1024)} MB)`);
  const mimeType = sniffImageType(bytes);
  if (!mimeType) throw new HttpError(400, 'Image must be a JPEG or PNG');
  const size = readImageSize(bytes);

  return { bytes, mimeType, cameraCode, frameTimestampSec, width: size?.width ?? null, height: size?.height ?? null };
}

async function readLimitedText(request: Request): Promise<string> {
  const buf = new Uint8Array(await request.arrayBuffer());
  if (buf.length > MAX_BODY_BYTES) throw new HttpError(413, `Frame too large (max ${MAX_IMAGE_BYTES / (1024 * 1024)} MB)`);
  return new TextDecoder().decode(buf);
}
