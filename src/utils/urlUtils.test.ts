import { describe, it, expect } from 'vitest';
import { getDirectVideoUrl, getDriveEmbedUrl } from './urlUtils';

const FALLBACK_1 = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4';

describe('getDirectVideoUrl', () => {
  it('returns .mp4 URLs unchanged', () => {
    const url = 'https://x.supabase.co/storage/v1/object/public/videos/a.mp4';
    expect(getDirectVideoUrl(url)).toBe(url);
  });

  it('returns .mp4 URLs with a query string unchanged', () => {
    const url = 'https://cdn.example.com/a.mp4?token=abc';
    expect(getDirectVideoUrl(url, 'cam-003')).toBe(url);
  });

  it('converts a Google Drive /file/d/ share link into a direct download link', () => {
    expect(getDirectVideoUrl('https://drive.google.com/file/d/AbC_12-x/view?usp=sharing')).toBe(
      'https://drive.google.com/uc?export=download&id=AbC_12-x',
    );
  });

  it('falls back to the per-camera stream when url is empty', () => {
    expect(getDirectVideoUrl('', 'cam-005')).toMatch(/ForBiggerMeltdowns\.mp4$/);
  });

  it('falls back to cam-001 stream for unknown camera and unusable url', () => {
    expect(getDirectVideoUrl('', 'cam-999')).toBe(FALLBACK_1);
    expect(getDirectVideoUrl('')).toBe(FALLBACK_1);
  });

  it('drive link without /file/d/ falls through to camera fallback', () => {
    expect(getDirectVideoUrl('https://drive.google.com/open?id=XYZ', 'cam-002')).toMatch(/ForBiggerEscapes/);
  });

  // BUG: extension check is case-sensitive and mp4-only. A perfectly valid
  // Supabase Storage URL ending in `.MP4`, `.webm` or `.mov` is silently
  // replaced with an unrelated Google sample video.
  it.fails('BUG: keeps valid non-lowercase-mp4 video URLs (e.g. .MP4 / .webm)', () => {
    const upper = 'https://x.supabase.co/storage/v1/object/public/videos/CAM.MP4';
    const webm = 'https://x.supabase.co/storage/v1/object/public/videos/cam.webm';
    expect(getDirectVideoUrl(upper, 'cam-001')).toBe(upper);
    expect(getDirectVideoUrl(webm, 'cam-001')).toBe(webm);
  });
});

describe('getDriveEmbedUrl', () => {
  it('returns null for non-drive urls and empty input', () => {
    expect(getDriveEmbedUrl('')).toBeNull();
    expect(getDriveEmbedUrl('https://example.com/file/d/abc')).toBeNull();
  });

  it('builds the /preview embed url from a share link', () => {
    expect(getDriveEmbedUrl('https://drive.google.com/file/d/ID_123/view')).toBe(
      'https://drive.google.com/file/d/ID_123/preview',
    );
  });

  it('returns null for drive urls without a file id', () => {
    expect(getDriveEmbedUrl('https://drive.google.com/drive/folders/xyz')).toBeNull();
  });
});
