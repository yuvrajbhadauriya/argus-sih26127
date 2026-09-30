import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeSupabase } from '@/test/supabaseMock';

const h = vi.hoisted(() => ({ configured: false, fake: null as unknown as ReturnType<typeof createFakeSupabase> }));

vi.mock('@/lib/supabase/client', async () => {
  const { createFakeSupabase } = await import('@/test/supabaseMock');
  h.fake = createFakeSupabase();
  return {
    supabase: h.fake.client,
    isSupabaseConfigured: () => h.configured,
  };
});

import {
  resolveSupabaseVideoUrl,
  CAMERA_VIDEOS,
  SUPABASE_STORAGE_BASE,
  getCameras,
  getCameraById,
  getCamerasByZone,
} from './cameras';
import { mockCameras } from '@/data/mockCameras';

beforeEach(() => {
  h.configured = false;
  h.fake.reset();
});

describe('resolveSupabaseVideoUrl', () => {
  it('passes through absolute http(s) URLs', () => {
    expect(resolveSupabaseVideoUrl('https://a.b/c.mp4')).toBe('https://a.b/c.mp4');
    expect(resolveSupabaseVideoUrl('http://a.b/c.mp4')).toBe('http://a.b/c.mp4');
  });

  it('maps a relative path containing a known filename to the storage bucket', () => {
    const f = CAMERA_VIDEOS[3].filename;
    expect(resolveSupabaseVideoUrl(`/videos/${f}`)).toBe(`${SUPABASE_STORAGE_BASE}${f}`);
  });

  it('matches by code case-insensitively and by id alias', () => {
    const ig = `${SUPABASE_STORAGE_BASE}${CAMERA_VIDEOS[0].filename}`;
    expect(resolveSupabaseVideoUrl(undefined, 'ig-01')).toBe(ig);
    expect(resolveSupabaseVideoUrl(undefined, 'IG-01')).toBe(ig);
    expect(resolveSupabaseVideoUrl('/videos/cam_001.mp4', undefined, 'cam-001')).toBe(ig);
  });

  it('is deterministic for unknown codes and always returns a bucket URL', () => {
    const a = resolveSupabaseVideoUrl(undefined, 'ZZ-99');
    expect(a).toBe(resolveSupabaseVideoUrl(undefined, 'ZZ-99'));
    expect(a.startsWith(SUPABASE_STORAGE_BASE)).toBe(true);
    expect(resolveSupabaseVideoUrl()).toMatch(/\.mp4$/);
  });

  // BUG: commit cab6ab3 claims "all 9 cameras load their unique video ... without
  // repeating", but CAMERA_VIDEOS maps CC-01, DW-01 and DK-01 onto the same files
  // as IG-01, CP-01 and KB-01 (src/lib/supabase/cameras.ts:21-23).
  it.fails('BUG: each of the 9 cameras resolves to a unique video file', () => {
    const files = new Set(CAMERA_VIDEOS.map((c) => c.filename));
    expect(files.size).toBe(CAMERA_VIDEOS.length);
  });

  // BUG: the frontend video map disagrees with camera_config.json (the file the
  // detection pipeline actually ran on) for KB-01, CC-01, DW-01, DK-01, so the
  // bbox overlay for those cameras is drawn on top of a *different* video.
  it.fails('BUG: frontend video per camera matches camera_config.json used by the pipeline', async () => {
    const cfg = (await import('../../../camera_config.json')).default as {
      camera_code: string;
      video_filename: string;
    }[];
    for (const c of cfg) {
      const fe = CAMERA_VIDEOS.find((v) => v.code === c.camera_code);
      expect({ code: c.camera_code, file: fe?.filename }).toEqual({ code: c.camera_code, file: c.video_filename });
    }
  });

  // BUG: three different CAM-X → code alias tables exist and disagree.
  // cameras.ts says cam-d → LN-01, cam-e → AI-01, cam-h → DW-01;
  // useCameraDetections.ts and insert_detections.py say CAM-D → DW-01, CAM-E → LN-01, CAM-G → AI-01.
  it.fails('BUG: CAM-D alias resolves to DW-01 as in useCameraDetections/insert_detections', () => {
    const dw = `${SUPABASE_STORAGE_BASE}${CAMERA_VIDEOS.find((v) => v.code === 'DW-01')!.filename}`;
    const lnAliases = CAMERA_VIDEOS.find((v) => v.code === 'LN-01')!.aliases;
    expect(lnAliases).not.toContain('cam-d');
    expect(resolveSupabaseVideoUrl(undefined, 'CAM-D')).toBe(dw);
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
      expect(c.video_url.startsWith('http')).toBe(true);
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
        { id: 'cam-001', name: 'A', code: 'IG-01', lat: 1.5, lng: 2.5, zone: 'Z', direction: 'N', status: 'online', video_url: '/videos/cam_001.mp4', created_at: 't' },
      ],
    });
    const cams = await getCameras();
    expect(cams[0]).toMatchObject({ id: 'cam-001', latitude: 1.5, longitude: 2.5 });
    expect(cams[0].video_url).toBe(`${SUPABASE_STORAGE_BASE}${CAMERA_VIDEOS[0].filename}`);
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
    h.fake.enqueue('cameras', { data: { id: 'cam-002', code: 'CP-01', lat: 1, lng: 2 } });
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
