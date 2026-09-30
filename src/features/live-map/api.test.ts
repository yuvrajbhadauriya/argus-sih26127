import { describe, it, expect, vi, afterEach } from 'vitest';
import { clearSimSummaryCache, fetchSimSummary } from './api';

const SUMMARY = { simulated: true, stats: { vehicles: 10, journeys: 5, sightings: 20, hop_speed_kmph: { mean: 22.3 }, sightings_per_hour: new Array(24).fill(1) } };

afterEach(() => {
  clearSimSummaryCache();
  vi.unstubAllGlobals();
});

describe('fetchSimSummary', () => {
  it('fetches once and caches', async () => {
    const f = vi.fn(() => Promise.resolve(new Response(JSON.stringify(SUMMARY))));
    vi.stubGlobal('fetch', f);
    const [a, b] = await Promise.all([fetchSimSummary(), fetchSimSummary()]);
    expect(a.stats.vehicles).toBe(10);
    expect(b).toBe(a);
    await fetchSimSummary();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('rejects on HTTP errors and bad shapes without caching', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('x', { status: 404 }))));
    await expect(fetchSimSummary()).rejects.toThrow(/404/);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{"stats":{}}'))));
    await expect(fetchSimSummary()).rejects.toThrow(/shape/);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(SUMMARY)))));
    await expect(fetchSimSummary()).resolves.toMatchObject({ simulated: true });
  });
});
