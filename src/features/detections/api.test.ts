import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DETECTIONS_MANIFEST_URL, fetchCameraEvents, resetCameraEventsCache, resetDetectionsManifest } from './api';

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
