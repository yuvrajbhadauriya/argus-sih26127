import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeDataApi, fail, row, rows } from '@/test/dataApiMock';

const h = vi.hoisted(() => ({ token: null as string | null }));

vi.mock('@/lib/supabase/client', () => ({
  getAccessToken: async () => h.token,
}));

import { apiRow, apiRows, apiSend, DataApiError } from './dataApi';

const api = createFakeDataApi();

beforeEach(() => {
  h.token = null;
  api.reset();
  vi.stubGlobal('fetch', api.fetch);
});

afterEach(() => vi.unstubAllGlobals());

describe('dataApi', () => {
  it('GETs same-origin /api/data routes with params, without auth by default', async () => {
    h.token = 'tok';
    api.enqueue('vehicles', rows([{ plate_text: 'X' }]));
    expect(await apiRows('vehicles', { q: 'MH', empty: '', none: undefined })).toEqual([{ plate_text: 'X' }]);
    expect(api.fetch.mock.calls[0][0]).toBe('/api/data/vehicles?q=MH');
    expect(api.calls[0].headers.get('authorization')).toBeNull();
  });

  it('adds the bearer token when asked (reads) and always for writes', async () => {
    h.token = 'tok';
    await apiRows('audit-log', {}, { auth: true });
    expect(api.calls[0].headers.get('authorization')).toBe('Bearer tok');
    api.enqueue('alerts/acknowledge', row({ id: 'a' }));
    await apiSend('alerts/acknowledge', 'POST', { id: 'a' });
    expect(api.calls[1]).toMatchObject({ method: 'POST', body: { id: 'a' } });
    expect(api.calls[1].headers.get('authorization')).toBe('Bearer tok');
  });

  it('refuses a write without a session, before any request', async () => {
    await expect(apiSend('watchlist', 'POST', {})).rejects.toMatchObject({ status: 401 });
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it('turns error bodies into DataApiError(status, message)', async () => {
    api.enqueue('cameras', fail(429, 'Too many requests — slow down'));
    const err = await apiRows('cameras').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DataApiError);
    expect(err).toMatchObject({ status: 429, message: 'Too many requests — slow down' });
    api.enqueue('cameras', { status: 500, body: 'oops' });
    await expect(apiRows('cameras')).rejects.toThrow('HTTP 500');
    api.enqueue('cameras', new TypeError('offline'));
    await expect(apiRows('cameras')).rejects.toMatchObject({ status: 0, message: 'Data API is unreachable' });
  });

  it('apiRow returns null for a missing row; apiRows [] for a missing list', async () => {
    api.enqueue('model-status', row(null));
    expect(await apiRow('model-status')).toBeNull();
    api.enqueue('cameras', { body: {} });
    expect(await apiRows('cameras')).toEqual([]);
  });
});

describe('dataApi — request sharing', () => {
  it('shares identical concurrent public GETs, not sequential ones', async () => {
    api.enqueue('alerts', rows([{ id: 1 }]), rows([{ id: 2 }]));
    const [a, b] = await Promise.all([apiRows('alerts'), apiRows('alerts')]);
    expect(a).toEqual([{ id: 1 }]);
    expect(b).toBe(a);
    expect(api.calls).toHaveLength(1);
    expect(await apiRows('alerts')).toEqual([{ id: 2 }]);
    expect(api.calls).toHaveLength(2);
  });
});
