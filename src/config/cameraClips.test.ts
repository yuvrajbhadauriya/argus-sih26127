import { describe, it, expect } from 'vitest';
import clips from './cameraClips.json';
import { clipSlugFor, pexelsIdOf, pexelsUrlOf, requireClipSlug, supabaseClipUrl } from './cameraClips';
import { mockCameras } from '@/mocks/fixtures/mockCameras';
import { CAMERA_VIDEOS, clipUrls } from '@/features/cameras/api';

describe('camera clip registry (src/config/cameraClips.json)', () => {
  it('names one clip per camera, each carrying its Pexels id', () => {
    expect(Object.keys(clips).sort()).toEqual(mockCameras.map((c) => c.code).sort());
    expect(new Set(Object.values(clips)).size).toBe(mockCameras.length);
    for (const slug of Object.values(clips)) expect(slug).toMatch(/^[a-z0-9]+_[a-z0-9-]+_pexels\d+$/);
  });

  it('is the only source of the camera → clip mapping', () => {
    for (const c of mockCameras) {
      expect(c.video_slug).toBe(clipSlugFor(c.code));
      expect(c.video_url).toBe(supabaseClipUrl(clipSlugFor(c.code)));
    }
    expect(CAMERA_VIDEOS.map((v) => [v.code, v.slug])).toEqual(mockCameras.map((c) => [c.code, clipSlugFor(c.code)]));
  });

  it('gives KR-01 and AN-01 their new Pexels clips, with the camera text unchanged', () => {
    expect(clipSlugFor('KR-01')).toBe('mumbai_kurla-depot-junction_pexels12974288');
    expect(clipSlugFor('AN-01')).toBe('mumbai_andheri-flyover-gundavali_pexels13270133');
    const kr = mockCameras.find((c) => c.code === 'KR-01')!;
    const an = mockCameras.find((c) => c.code === 'AN-01')!;
    expect([kr.name, kr.zone, kr.direction, kr.road]).toEqual([
      'Kurla Depot Junction',
      'Eastern Suburbs',
      'Northbound',
      'LBS Marg at Kurla Depot, Kurla West',
    ]);
    expect([an.name, an.zone, an.direction, an.road]).toEqual([
      'Andheri Flyover (Gundavali)',
      'Western Suburbs',
      'Southbound',
      'Western Express Highway at Andheri–Kurla Road (Andheri Flyover)',
    ]);
    expect(clipUrls(clipSlugFor('KR-01'), 'local')).toEqual({
      video: '/videos-local/mumbai_kurla-depot-junction_pexels12974288.mp4',
      poster: '/videos-local/mumbai_kurla-depot-junction_pexels12974288.jpg',
    });
  });

  it('keeps the Pexels credit of every clip', () => {
    expect(pexelsIdOf(clipSlugFor('KR-01'))).toBe('12974288');
    expect(pexelsUrlOf(clipSlugFor('KR-01'))).toBe('https://www.pexels.com/video/12974288/');
    expect(pexelsUrlOf(clipSlugFor('AN-01'))).toBe('https://www.pexels.com/video/13270133/');
    expect(pexelsIdOf('not-a-pexels-clip')).toBeNull();
    expect(pexelsUrlOf('not-a-pexels-clip')).toBeNull();
  });

  it('is strict about unknown cameras', () => {
    expect(clipSlugFor('ZZ-99')).toBe('');
    expect(() => requireClipSlug('ZZ-99')).toThrow(/No clip registered for camera ZZ-99/);
  });
});
