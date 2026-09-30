import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { SUPABASE_PUBLIC_OBJECT_BASE } from '@/config/constants';
import { signedUrlCache } from '@/features/golden-set/lib/signedUrls';
import { invalidateSignedMedia, SIGNED_REFRESH_TICK_MS, storageRef, useSignedMediaUrl } from './signedMedia';

const CLIP = `${SUPABASE_PUBLIC_OBJECT_BASE}videos/mumbai/720p/mumbai_clip.mp4`;
let n = 0;
const signFetch = vi.fn(async (url: RequestInfo | URL) => {
  const u = new URL(String(url), 'http://localhost');
  const paths = (u.searchParams.get('paths') ?? '').split(',');
  n++;
  return new Response(JSON.stringify({ urls: Object.fromEntries(paths.map((p) => [p, `https://signed.example/${p}?token=${n}`])), expires_in: 3600 }), { status: 200 });
});

beforeEach(() => {
  n = 0;
  signFetch.mockClear();
  vi.stubGlobal('fetch', signFetch);
  signedUrlCache('videos').invalidate('mumbai/720p/mumbai_clip.mp4');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('storageRef', () => {
  it('recognises public-object URLs of signable bucket prefixes only', () => {
    expect(storageRef(CLIP)).toEqual({ bucket: 'videos', path: 'mumbai/720p/mumbai_clip.mp4' });
    expect(storageRef(`${SUPABASE_PUBLIC_OBJECT_BASE}videos/other/x.mp4`)).toBeNull();
    expect(storageRef(`${SUPABASE_PUBLIC_OBJECT_BASE}secret/mumbai/720p/x.mp4`)).toBeNull();
    expect(storageRef('/videos-local/mumbai_clip.mp4')).toBeNull();
    expect(storageRef(undefined)).toBeNull();
  });
});

describe('useSignedMediaUrl', () => {
  it('passes non-storage URLs through without signing', () => {
    const { result } = renderHook(() => useSignedMediaUrl('/videos-local/a.mp4'));
    expect(result.current).toBe('/videos-local/a.mp4');
    expect(signFetch).not.toHaveBeenCalled();
  });

  it('resolves a storage URL to a signed URL via /api/media/sign', async () => {
    const { result } = renderHook(() => useSignedMediaUrl(CLIP));
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toBe('https://signed.example/mumbai/720p/mumbai_clip.mp4?token=1'));
    expect(String(signFetch.mock.calls[0][0])).toContain('/api/media/sign?bucket=videos');
  });

  it('keeps the old URL while re-signing near expiry, then swaps', async () => {
    // Real setTimeout (for settling); fake clock + interval (for the refresh tick).
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 20)));
    const { result } = renderHook(() => useSignedMediaUrl(CLIP));
    await settle();
    expect(result.current).toContain('token=1');
    // 56 minutes later the URL is inside the 5-minute refresh margin.
    vi.setSystemTime(Date.now() + 56 * 60_000);
    act(() => {
      vi.advanceTimersByTime(SIGNED_REFRESH_TICK_MS);
    });
    expect(result.current).toContain('token=1');
    await settle();
    expect(result.current).toContain('token=2');
  });

  it('re-signs after invalidateSignedMedia (e.g. the element hit an expired URL)', async () => {
    const { result } = renderHook(() => useSignedMediaUrl(CLIP));
    await waitFor(() => expect(result.current).toContain('token=1'));
    act(() => {
      expect(invalidateSignedMedia(CLIP)).toBe(true);
    });
    await waitFor(() => expect(result.current).toContain('token=2'));
    expect(invalidateSignedMedia('/videos-local/a.mp4')).toBe(false);
  });
});
