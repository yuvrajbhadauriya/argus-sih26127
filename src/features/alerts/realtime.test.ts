import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  configured: true,
  handlers: {} as Record<string, (p: { new: Record<string, unknown> }) => void>,
  channelName: '',
  removed: 0,
  subscribeCb: null as null | ((s: string) => void),
  single: null as null | { data: unknown; error: unknown },
}));

vi.mock('@/lib/supabase/client', () => {
  const channel = {
    on: (_kind: string, filter: { event: string; table: string }, cb: (p: { new: Record<string, unknown> }) => void) => {
      h.handlers[`${filter.event}:${filter.table}`] = cb;
      return channel;
    },
    subscribe: (cb: (s: string) => void) => {
      h.subscribeCb = cb;
      return channel;
    },
  };
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: () => Promise.resolve(h.single ?? { data: null, error: null }),
  };
  const client = {
    channel: (name: string) => {
      h.channelName = name;
      return channel;
    },
    removeChannel: () => {
      h.removed++;
      return Promise.resolve('ok');
    },
    from: () => builder,
  };
  return { getSupabase: async () => client, isSupabaseConfigured: () => h.configured };
});

import { subscribeAlertsRealtime } from './realtime';
import { subscribeAlertEvents, type AlertEvent } from './live';

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  h.handlers = {};
  h.removed = 0;
  h.single = null;
  h.configured = true;
});

describe('alerts realtime', () => {
  it('subscribes to INSERT/UPDATE on alerts only (never detections) and emits events', async () => {
    const statuses: string[] = [];
    const events: AlertEvent[] = [];
    const off = subscribeAlertEvents((e) => events.push(e));
    const stop = subscribeAlertsRealtime((s) => statuses.push(s));
    await flush();
    expect(Object.keys(h.handlers).sort()).toEqual(['INSERT:alerts', 'UPDATE:alerts']);
    h.subscribeCb!('SUBSCRIBED');
    expect(statuses).toEqual(['connecting', 'subscribed']);

    h.single = { data: { id: 'a1', status: 'open', created_at: '2026-09-29T08:00:00Z', detections: { plate_text_raw: 'MH 01 CS 0126', cameras: { name: 'Jogeshwari', code: 'JG-01' } }, blacklist_entries: { priority: 'critical' } }, error: null };
    h.handlers['INSERT:alerts']({ new: { id: 'a1', status: 'open' } });
    await flush();
    expect(events[0]).toMatchObject({ type: 'insert', source: 'realtime', alert: { id: 'a1', plate_text: 'MH 01 CS 0126', priority: 'critical', camera_code: 'JG-01' } });

    h.handlers['UPDATE:alerts']({ new: { id: 'a1', status: 'acknowledged', acknowledged_by: 'op@x' } });
    expect(events[1]).toMatchObject({ type: 'update', alert: { id: 'a1', acknowledged: true, acknowledged_by: 'op@x' } });

    stop();
    expect(h.removed).toBe(1);
    off();
  });

  it('is a no-op without Supabase', () => {
    h.configured = false;
    const statuses: string[] = [];
    subscribeAlertsRealtime((s) => statuses.push(s))();
    expect(statuses).toEqual(['off']);
  });
});
