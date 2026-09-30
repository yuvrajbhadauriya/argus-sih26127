import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeDataApi, fail, rows } from '@/test/dataApiMock';

const h = vi.hoisted(() => ({ configured: true }));

vi.mock('@/lib/supabase/client', () => ({
  getSupabase: async () => {
    throw new Error('the browser must not query tables directly');
  },
  isSupabaseConfigured: () => h.configured,
  getAccessToken: async () => null,
}));

import { ALERTS_POLL_MS, MAX_INSERTS_PER_POLL, subscribeAlertsLive } from './livePoll';
import { subscribeAlertEvents, type AlertEvent } from './live';

const api = createFakeDataApi();
const flush = () => new Promise((r) => setTimeout(r, 10));
const alertRow = (id: string, extra: Record<string, unknown> = {}) => ({ id, status: 'open', created_at: '2026-09-29T08:00:00Z', ...extra });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  h.configured = true;
  api.reset();
  vi.stubGlobal('fetch', api.fetch);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('alerts live poll (/api/data/alerts)', () => {
  it('uses the first answer as baseline, then emits inserts and acknowledgement updates', async () => {
    const statuses: string[] = [];
    const events: AlertEvent[] = [];
    const off = subscribeAlertEvents((e) => events.push(e));
    api.enqueue('alerts', rows([alertRow('a1')]));
    const stop = subscribeAlertsLive((s) => statuses.push(s));
    await flush();
    expect(statuses).toEqual(['connecting', 'subscribed']);
    expect(events).toEqual([]);

    api.enqueue(
      'alerts',
      rows([
        alertRow('a2', { detections: { plate_text_raw: 'MH 01 CS 0126', cameras: { name: 'Jogeshwari', code: 'JG-01' } }, blacklist_entries: { priority: 'critical' } }),
        alertRow('a1', { status: 'acknowledged', acknowledged_by: 'op@x' }),
      ]),
    );
    vi.advanceTimersByTime(ALERTS_POLL_MS);
    await flush();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'insert', source: 'live', alert: { id: 'a2', plate_text: 'MH 01 CS 0126', priority: 'critical', camera_code: 'JG-01' } });
    expect(events[1]).toMatchObject({ type: 'update', alert: { id: 'a1', acknowledged: true, acknowledged_by: 'op@x' } });
    expect(api.calls.every((c) => c.route === 'alerts' && c.method === 'GET')).toBe(true);

    stop();
    vi.advanceTimersByTime(ALERTS_POLL_MS * 3);
    await flush();
    expect(api.calls).toHaveLength(2);
    off();
  });

  it(`caps a burst at ${MAX_INSERTS_PER_POLL} insert events (newest)`, async () => {
    const events: AlertEvent[] = [];
    const off = subscribeAlertEvents((e) => events.push(e));
    api.enqueue('alerts', rows([]));
    const stop = subscribeAlertsLive();
    await flush();
    api.enqueue('alerts', rows(Array.from({ length: 12 }, (_, i) => alertRow(`n${i}`))));
    vi.advanceTimersByTime(ALERTS_POLL_MS);
    await flush();
    expect(events.map((e) => e.alert.id)).toEqual(['n4', 'n3', 'n2', 'n1', 'n0']);
    stop();
    off();
  });

  it('reports errors and recovers on the next poll', async () => {
    const statuses: string[] = [];
    api.enqueue('alerts', fail(502, 'down'));
    const stop = subscribeAlertsLive((s) => statuses.push(s));
    await flush();
    expect(statuses).toEqual(['connecting', 'error']);
    vi.advanceTimersByTime(ALERTS_POLL_MS);
    await flush();
    expect(statuses.at(-1)).toBe('subscribed');
    stop();
  });

  it('is a no-op without a database', () => {
    h.configured = false;
    const statuses: string[] = [];
    subscribeAlertsLive((s) => statuses.push(s))();
    expect(statuses).toEqual(['off']);
    expect(api.fetch).not.toHaveBeenCalled();
  });
});
