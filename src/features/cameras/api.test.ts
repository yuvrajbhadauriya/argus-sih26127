import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeDataApi, fail, row, rows } from '@/test/dataApiMock';

const h = vi.hoisted(() => ({ configured: false }));

vi.mock('@/lib/supabase/client', () => ({
  getSupabase: async () => {
    throw new Error('the browser must not query tables directly');
  },
  isSupabaseConfigured: () => h.configured,
  getAccessToken: async () => 'op-token',
}));

const api = createFakeDataApi();

import {
  resolveCameraMedia,
  resolveSupabaseVideoUrl,
  resolveVideoUrl,
  CAMERA_VIDEOS,
  SUPABASE_STORAGE_BASE,
  getCameras,
  getCameraById,
  getCamerasByZone,
  createCamera,
  updateCamera,
} from './api';
import { CODE_ALIAS_MAP } from '@/features/detections/api';
import { mockCameras } from '@/mocks/fixtures/mockCameras';

beforeEach(() => {
  h.configured = false;
  api.reset();
  vi.stubGlobal('fetch', api.fetch);
});

afterEach(() => vi.unstubAllGlobals());

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
    expect(api.fetch).not.toHaveBeenCalled();
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

describe('getCameras (live, via /api/data)', () => {
  beforeEach(() => {
    h.configured = true;
  });

  it('reads /api/data/cameras and normalises lat/lng', async () => {
    api.enqueue(
      'cameras',
      rows([{ id: 'cam-001', name: 'A', code: 'JG-01', lat: 1.5, lng: 2.5, zone: 'Z', direction: 'N', status: 'online', video_url: '/videos/cam_001.mp4', created_at: 't' }]),
    );
    const cams = await getCameras();
    expect(cams[0]).toMatchObject({ id: 'cam-001', latitude: 1.5, longitude: 2.5 });
    expect(cams[0].video_url).toBe(resolveVideoUrl(undefined, 'JG-01'));
    expect(cams[0].video_url).toContain(CAMERA_VIDEOS[0].slug);
    expect(api.calls[0]).toMatchObject({ route: 'cameras', method: 'GET' });
  });

  it('keeps lat=0 (uses ?? not ||)', async () => {
    api.enqueue('cameras', rows([{ id: 'x', code: 'Q', lat: 0, lng: 0, latitude: 9, longitude: 9 }]));
    const [c] = await getCameras();
    expect(c.latitude).toBe(0);
    expect(c.longitude).toBe(0);
  });

  it('throws a descriptive error when the request fails', async () => {
    api.enqueue('cameras', fail(502, 'boom'));
    await expect(getCameras()).rejects.toThrow('Failed to fetch cameras: boom');
  });

  it('returns [] on a body without rows', async () => {
    api.enqueue('cameras', { body: {} });
    expect(await getCameras()).toEqual([]);
  });

  it('getCameraById asks for one id', async () => {
    api.enqueue('cameras', row({ id: 'cam-002', code: 'AN-01', lat: 1, lng: 2 }));
    const cam = await getCameraById('cam-002');
    expect(cam?.id).toBe('cam-002');
    expect(api.calls[0].params.get('id')).toBe('cam-002');
  });

  it('getCamerasByZone filters and throws on error', async () => {
    api.enqueue('cameras', rows([{ id: 'a', code: 'A', zone: 'Z' }, { id: 'b', code: 'B', zone: 'Y' }]));
    expect((await getCamerasByZone('Z')).map((c) => c.id)).toEqual(['a']);
    api.enqueue('cameras', fail(502, 'nope'));
    await expect(getCamerasByZone('Z')).rejects.toThrow('Failed to fetch cameras by zone: nope');
  });

  it('createCamera / updateCamera go through the API with the operator token', async () => {
    api.enqueue('cameras', { status: 201, body: { row: { id: 'cam-tt-01', code: 'TT-01', lat: 19, lng: 72 } } });
    const cam = await createCamera({ name: 'T', code: 'TT-01', zone: 'Z', direction: 'N', latitude: 19, longitude: 72 });
    expect(cam).toMatchObject({ id: 'cam-tt-01', latitude: 19 });
    expect(api.calls[0]).toMatchObject({ method: 'POST', body: { code: 'TT-01', latitude: 19, longitude: 72 } });
    expect(api.calls[0].headers.get('authorization')).toBe('Bearer op-token');

    api.enqueue('cameras', row({ id: 'cam-tt-01' }));
    await updateCamera('cam-tt-01', { name: 'New' });
    expect(api.calls[1]).toMatchObject({ method: 'PATCH', body: { name: 'New' } });
    expect(api.calls[1].params.get('id')).toBe('cam-tt-01');
  });
});
