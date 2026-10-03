import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DETECTIONS_MANIFEST_URL,
  detectionsMatchClip,
  fetchCameraDetections,
  fetchCameraEvents,
  loadDetectionsManifest,
  resetCameraEventsCache,
  resetDetectionsManifest,
} from './api';
import { clipSlugFor } from '@/config/cameraClips';

beforeEach(() => {
  resetDetectionsManifest();
  resetCameraEventsCache();
});
afterEach(() => vi.unstubAllGlobals());

describe('detection file fetches', () => {
  it('revalidate the manifest and the events file with the server on every load', async () => {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(url === DETECTIONS_MANIFEST_URL ? { cameras: ['SC-01'] } : { camera_code: 'SC-01', events: [] }),
      } as Response),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchCameraEvents('SC-01');

    // A copy cached before a data update must not pair the old clip's reads with the new clip.
    expect(fetchMock).toHaveBeenCalledWith(DETECTIONS_MANIFEST_URL, { cache: 'no-cache' });
    expect(fetchMock).toHaveBeenCalledWith('/detections/events_SC-01.json', { cache: 'no-cache' });
  });
});

describe('detections must belong to the clip the camera plays', () => {
  const files = (map: Record<string, unknown>) =>
    vi.fn((url: string) =>
      url in map
        ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(map[url]) } as Response)
        : Promise.resolve({ ok: false, status: 404, json: () => Promise.reject(new Error('404')) } as Response),
    );

  it.each(['KR-01', 'AN-01'])('%s: files made on the previous clip are ignored, not drawn on the new video', async (code) => {
    const fetchMock = files({
      [DETECTIONS_MANIFEST_URL]: {
        cameras: [code, 'SC-01'],
        stats: [
          { camera_code: code, video_filename: 'an_old_clip_pexels1.mp4' },
          { camera_code: 'SC-01', video_filename: `${clipSlugFor('SC-01')}.mp4` },
        ],
      },
      [`/detections/events_${code}.json`]: { clip: { file: 'an_old_clip_pexels1.mp4' }, events: [{ plate_text: 'MH 01 EB 7023' }] },
      [`/detections/detections_${code}.json`]: [{ plate_text: 'MH 01 EB 7023' }],
    });
    vi.stubGlobal('fetch', fetchMock);

    expect([...(await loadDetectionsManifest())]).toEqual(['SC-01']);
    expect(await fetchCameraEvents(code)).toBeNull();
    expect(await fetchCameraDetections(code)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalledWith(`/detections/detections_${code}.json`, expect.anything());
    expect(fetchMock).not.toHaveBeenCalledWith(`/detections/events_${code}.json`, expect.anything());
  });

  it.each(['KR-01', 'AN-01'])('%s: files made on the current clip are used', async (code) => {
    const clip = `${clipSlugFor(code)}.mp4`;
    vi.stubGlobal(
      'fetch',
      files({
        [DETECTIONS_MANIFEST_URL]: { cameras: [code], stats: [{ camera_code: code, video_filename: clip }] },
        [`/detections/events_${code}.json`]: { clip: { file: clip, fps: 30, frames: 600 }, events: [{ plate_text: 'MH 02 AB 1234' }] },
        [`/detections/detections_${code}.json`]: [{ plate_text: 'MH 02 AB 1234', bbox: { x: 1, y: 2, width: 3, height: 4 } }],
      }),
    );
    const events = await fetchCameraEvents(code);
    expect(events?.duration_sec).toBe(20);
    expect(events?.events).toHaveLength(1);
    expect((await fetchCameraDetections(code)).map((d) => d.plate_text_raw)).toEqual(['MH 02 AB 1234']);
  });

  it('events whose own clip name is another clip are refused even if the manifest lists the camera', async () => {
    vi.stubGlobal(
      'fetch',
      files({
        [DETECTIONS_MANIFEST_URL]: { cameras: ['KR-01'] },
        '/detections/events_KR-01.json': { clip: { file: 'mumbai_flyover-roadside-approach-taxis_pexels31048404.mp4' }, events: [{}] },
      }),
    );
    expect(await fetchCameraEvents('KR-01')).toBeNull();
  });

  it('degrades to "no detections" when the manifest or a detections file is missing', async () => {
    vi.stubGlobal('fetch', files({}));
    expect([...(await loadDetectionsManifest())]).toEqual([]);
    expect(await fetchCameraEvents('KR-01')).toBeNull();
    expect(await fetchCameraDetections('KR-01')).toEqual([]);

    resetDetectionsManifest();
    vi.stubGlobal('fetch', files({ [DETECTIONS_MANIFEST_URL]: { cameras: ['KR-01'] } })); // listed, files absent
    expect(await fetchCameraEvents('KR-01')).toBeNull();
    resetDetectionsManifest();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    expect([...(await loadDetectionsManifest())]).toEqual([]);
  });

  it('detectionsMatchClip treats unknown information as matching and other clips as not', () => {
    const slug = clipSlugFor('KR-01');
    expect(detectionsMatchClip('KR-01', `${slug}.mp4`)).toBe(true);
    expect(detectionsMatchClip('KR-01', undefined)).toBe(true);
    expect(detectionsMatchClip('KR-01', 'other.mp4')).toBe(false);
    expect(detectionsMatchClip('ZZ-99', 'other.mp4')).toBe(true);
  });
});
