import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeSupabase } from '@/test/supabaseMock';

const h = vi.hoisted(() => ({ configured: false, fake: null as unknown as ReturnType<typeof createFakeSupabase> }));

vi.mock('@/lib/supabase/client', async () => {
  const { createFakeSupabase } = await import('@/test/supabaseMock');
  h.fake = createFakeSupabase();
  return {
    getSupabase: async () => h.fake.client,
    isSupabaseConfigured: () => h.configured,
  };
});

import {
  resolveCameraMedia,
  resolveSupabaseVideoUrl,
  resolveVideoUrl,
  CAMERA_VIDEOS,
  SUPABASE_STORAGE_BASE,
  getCameras,
  getCameraById,
  getCamerasByZone,
} from './api';
import { CODE_ALIAS_MAP } from '@/features/detections/api';
import { mockCameras } from '@/mocks/fixtures/mockCameras';

beforeEach(() => {
  h.configured = false;
  h.fake.reset();
});

const LOCAL = '/videos-local/';
const BUCKET = `${SUPABASE_STORAGE_BASE}mumbai/720p/`;

describe('resolveCameraMedia / resolveVideoUrl', () => {
  const vp = CAMERA_VIDEOS.find((c) => c.code === 'VP-01')!;

  it('plays each registry camera from the configured source, with the other as fallback', () => {
    expect(resolveCameraMedia(undefined, 'VP-01', undefined, 'local')).toEqual({
      video: `${LOCAL}${vp.slug}.mp4`,
      poster: `${LOCAL}${vp.slug}.jpg`,
      fallback: `${BUCKET}${vp.slug}.mp4`,
    });
    expect(resolveCameraMedia(undefined, 'VP-01', undefined, 'supabase')).toEqual({
      video: `${BUCKET}${vp.slug}.mp4`,
      poster: `${BUCKET}${vp.slug}.jpg`,
      fallback: `${LOCAL}${vp.slug}.mp4`,
    });
  });

  it('ignores a stale database video_url for registry cameras', () => {
    const old = 'https://x.supabase.co/storage/v1/object/public/videos/13052823_3840_2160_30fps.mp4';
    expect(resolveVideoUrl(old, 'VP-01', 'cam-003', 'supabase')).toBe(`${BUCKET}${vp.slug}.mp4`);
  });

  it('matches by slug in a URL, by code case-insensitively and by id alias', () => {
    const url = `${BUCKET}${vp.slug}.mp4`;
    expect(resolveVideoUrl(`/videos/${vp.slug}.mp4`, undefined, undefined, 'supabase')).toBe(url);
    expect(resolveVideoUrl(undefined, 'vp-01', undefined, 'supabase')).toBe(url);
    const id = mockCameras.find((c) => c.code === 'VP-01')!.id;
    expect(resolveVideoUrl(undefined, undefined, id, 'supabase')).toBe(url);
    expect(resolveSupabaseVideoUrl).toBe(resolveVideoUrl);
  });

  it('passes through absolute URLs of unknown cameras', () => {
    expect(resolveVideoUrl('https://a.b/c.mp4', 'ZZ-99')).toBe('https://a.b/c.mp4');
    expect(resolveCameraMedia('http://a.b/c.mp4', 'ZZ-99').fallback).toBe('');
  });

  it('is deterministic for unknown codes and always returns a registry clip', () => {
    const a = resolveVideoUrl(undefined, 'ZZ-99', undefined, 'supabase');
    expect(a).toBe(resolveVideoUrl(undefined, 'ZZ-99', undefined, 'supabase'));
    expect(a.startsWith(BUCKET)).toBe(true);
    expect(resolveVideoUrl()).toMatch(/\.mp4$/);
  });

  it('gives every camera its own clip, matching pipeline/camera_config.json', async () => {
    expect(new Set(CAMERA_VIDEOS.map((c) => c.slug)).size).toBe(CAMERA_VIDEOS.length);
    const cfg = (await import('../../../pipeline/camera_config.json')).default as { camera_code: string; video_slug: string }[];
    expect(CAMERA_VIDEOS.map((c) => [c.code, c.slug])).toEqual(cfg.map((c) => [c.camera_code, c.video_slug]));
  });

  it('CAM-X aliases follow registry order, as in detections/api CODE_ALIAS_MAP', () => {
    CAMERA_VIDEOS.forEach((c, i) => {
      const alias = `CAM-${String.fromCharCode(65 + i)}`;
      expect(CODE_ALIAS_MAP[alias]).toBe(c.code);
      expect(resolveVideoUrl(undefined, alias, undefined, 'supabase')).toBe(`${BUCKET}${c.slug}.mp4`);
    });
  });
});

describe('getCameras (mock fallback, Supabase not configured)', () => {
  it('maps all mock camera feeds into Camera shape with latitude/longitude', async () => {
    const cams = await getCameras();
    expect(cams).toHaveLength(mockCameras.length);
    for (const c of cams) {
      expect(typeof c.latitude).toBe('number');
      expect(typeof c.longitude).toBe('number');
      expect(['online', 'offline']).toContain(c.status);
      expect(c.video_url).toMatch(/\/(videos-local|mumbai\/720p)\/[a-z0-9_-]+\.mp4$/);
      expect(c.poster_url).toMatch(/\.jpg$/);
    }
    expect(h.fake.from).not.toHaveBeenCalled();
  });

  it('maps maintenance status to offline', async () => {
    const maint = mockCameras.find((c) => c.status === 'maintenance');
    if (!maint) return; // nothing to check in current mock data
    const cam = await getCameraById(maint.id);
    expect(cam?.status).toBe('offline');
  });

  it('getCameraById returns null for unknown id', async () => {
    expect(await getCameraById('nope')).toBeNull();
  });

  it('getCamerasByZone filters by zone', async () => {
    const zone = mockCameras[0].zone;
    const cams = await getCamerasByZone(zone);
    expect(cams.length).toBe(mockCameras.filter((c) => c.zone === zone).length);
    expect(cams.every((c) => c.zone === zone)).toBe(true);
  });
});

describe('getCameras (Supabase configured, mocked client)', () => {
  beforeEach(() => {
    h.configured = true;
  });

  it('queries cameras ordered by code and normalises lat/lng', async () => {
    h.fake.enqueue('cameras', {
      data: [
        { id: 'cam-001', name: 'A', code: 'JG-01', lat: 1.5, lng: 2.5, zone: 'Z', direction: 'N', status: 'online', video_url: '/videos/cam_001.mp4', created_at: 't' },
      ],
    });
    const cams = await getCameras();
    expect(cams[0]).toMatchObject({ id: 'cam-001', latitude: 1.5, longitude: 2.5 });
    expect(cams[0].video_url).toBe(resolveVideoUrl(undefined, 'JG-01'));
    expect(cams[0].video_url).toContain(CAMERA_VIDEOS[0].slug);
    const call = h.fake.calls[0];
    expect(call.table).toBe('cameras');
    expect(h.fake.opsFor(call, 'order')[0]).toEqual(['code']);
  });

  it('keeps lat=0 (uses ?? not ||)', async () => {
    h.fake.enqueue('cameras', { data: [{ id: 'x', code: 'Q', lat: 0, lng: 0, latitude: 9, longitude: 9 }] });
    const [c] = await getCameras();
    expect(c.latitude).toBe(0);
    expect(c.longitude).toBe(0);
  });

  it('throws a descriptive error when the query fails', async () => {
    h.fake.enqueue('cameras', { error: { message: 'boom' } });
    await expect(getCameras()).rejects.toThrow('Failed to fetch cameras: boom');
  });

  it('returns [] on null data', async () => {
    h.fake.enqueue('cameras', { data: null });
    expect(await getCameras()).toEqual([]);
  });

  it('getCameraById uses eq(id).single()', async () => {
    h.fake.enqueue('cameras', { data: { id: 'cam-002', code: 'AN-01', lat: 1, lng: 2 } });
    const cam = await getCameraById('cam-002');
    expect(cam?.id).toBe('cam-002');
    const call = h.fake.calls[0];
    expect(h.fake.opsFor(call, 'eq')[0]).toEqual(['id', 'cam-002']);
    expect(h.fake.opsFor(call, 'single')).toHaveLength(1);
  });

  it('getCamerasByZone throws on error', async () => {
    h.fake.enqueue('cameras', { error: { message: 'nope' } });
    await expect(getCamerasByZone('Z')).rejects.toThrow('Failed to fetch cameras by zone: nope');
  });
});
