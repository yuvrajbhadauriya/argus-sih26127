import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetchNetworkAnalytics, clearAnalyticsCache, ANALYTICS_CAMERAS } from './api';
import { resetSimCache } from '@/features/vehicles/sim';

/** Serve /sim/*.json from public/ like the dev server would. */
function serveSimFiles() {
  const fetchMock = vi.fn(async (url: string) => {
    const file = resolve(process.cwd(), 'public', String(url).replace(/^\//, ''));
    if (!existsSync(file)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(file, 'utf8')) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  clearAnalyticsCache();
  resetSimCache();
});
afterEach(() => vi.unstubAllGlobals());

describe('analytics data layer', () => {
  it('aggregates the simulated network once per window (memoised)', async () => {
    const f = serveSimFiles();
    const a = await fetchNetworkAnalytics('all');
    const b = await fetchNetworkAnalytics('all');
    expect(a).toBe(b);
    expect(f.mock.calls.filter(([u]) => String(u).includes('journeys')).length).toBe(1);
  });

  it('exposes the camera registry used for zones', () => {
    expect(ANALYTICS_CAMERAS.length).toBeGreaterThanOrEqual(8);
    for (const c of ANALYTICS_CAMERAS) expect(c.code).toMatch(/^[A-Z]{2}-\d{2}$/);
  });

  it('rejects when the simulation files are missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    await expect(fetchNetworkAnalytics('all')).rejects.toThrow();
  });
});
