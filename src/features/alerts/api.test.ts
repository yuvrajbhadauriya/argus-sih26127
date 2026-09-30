import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeSupabase } from '@/test/supabaseMock';
import { tableColumns } from '@/test/migrations';

const h = vi.hoisted(() => ({ configured: false, fake: null as unknown as ReturnType<typeof createFakeSupabase> }));

vi.mock('@/lib/supabase/client', async () => {
  const { createFakeSupabase } = await import('@/test/supabaseMock');
  h.fake = createFakeSupabase();
  return { getSupabase: async () => h.fake.client, isSupabaseConfigured: () => h.configured };
});

import { fetchAlerts, acknowledgeAlert, fetchBlacklistEntries, simAlertsAt, createWatchlistEntry, updateWatchlistEntry, rowToAlert, isAlertFallbackActive, isWatchlistFallbackActive } from './api';
import { resetReplay, startReplay, stopReplay, istOnDay } from '@/features/replay/clock';
import { mockAlertFeed as mockAlerts, mockBlacklistEntries } from '@/mocks/fixtures/mockAlerts';

beforeEach(() => {
  h.configured = false;
  h.fake.reset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('alerts — mock mode', () => {
  it('fetchAlerts returns mock alerts without touching the client', async () => {
    expect(await fetchAlerts()).toBe(mockAlerts);
    expect(h.fake.from).not.toHaveBeenCalled();
  });

  it('acknowledgeAlert mutates the matching mock alert', async () => {
    const target = mockAlerts[0];
    await acknowledgeAlert(target.id, 'Tester');
    expect(target.acknowledged).toBe(true);
    expect(target.acknowledged_by).toBe('Tester');
    expect(target.acknowledged_at).toBeTruthy();
  });

  it('acknowledgeAlert is a no-op for unknown ids', async () => {
    await expect(acknowledgeAlert('does-not-exist')).resolves.toBeUndefined();
  });

  it('fetchBlacklistEntries returns mock data', async () => {
    expect(await fetchBlacklistEntries()).toBe(mockBlacklistEntries);
  });
});

describe('alerts — Supabase configured (mocked client)', () => {
  beforeEach(() => {
    h.configured = true;
  });

  it('maps joined alert rows (detections → cameras, blacklist_entries)', async () => {
    h.fake.enqueue('alerts', {
      data: [
        {
          id: 'a1',
          detection_id: 'd1',
          blacklist_entry_id: 'b1',
          status: 'acknowledged',
          created_at: '2026-01-01T00:00:00Z',
          detections: { event_id: 'd1', camera_id: 'cam-002', plate_text_raw: 'MH 01 AB 1234', lat: 10, lng: 20, cameras: { name: 'CP' } },
          blacklist_entries: { id: 'b1', priority: 'critical', category: 'wanted', notes: 'n' },
        },
      ],
    });
    const [a] = await fetchAlerts();
    expect(a).toMatchObject({
      id: 'a1',
      detection_event_id: 'd1',
      plate_text: 'MH 01 AB 1234',
      camera_id: 'cam-002',
      camera_name: 'CP',
      priority: 'critical',
      category: 'wanted',
      reason: 'n',
      lat: 10,
      lng: 20,
      acknowledged: true,
    });
    const call = h.fake.calls[0];
    expect(h.fake.opsFor(call, 'order')[0]).toEqual(['created_at', { ascending: false }]);
  });

  it('falls back to a plain select when the join returns empty, and surfaces an error (never mocks)', async () => {
    h.fake.enqueue('alerts', { data: [] }, { error: { message: 'x' } });
    await expect(fetchAlerts()).rejects.toThrow('Failed to load alerts: x');
    expect(h.fake.calls).toHaveLength(2);
  });

  it('falls back to the simulated feed (tagged simulated) when the table is empty', async () => {
    h.fake.enqueue('alerts', { data: [] }, { data: [] });
    const alerts = await fetchAlerts();
    expect(alerts.length).toBe(mockAlerts.length);
    expect(alerts.every((a) => (a as { simulated?: boolean }).simulated)).toBe(true);
    expect(isAlertFallbackActive()).toBe(true);
  });

  it('acknowledges a simulated fallback alert locally (no database write)', async () => {
    h.fake.enqueue('alerts', { data: [] }, { data: [] });
    const [first] = await fetchAlerts();
    const writesBefore = h.fake.calls.length;
    await acknowledgeAlert(first.id, 'Operator');
    expect(h.fake.calls.length).toBe(writesBefore);
    expect(mockAlerts.find((a) => a.id === first.id)?.acknowledged).toBe(true);
  });

  it('shows real rows again (fallback off) once the table has alerts', async () => {
    h.fake.enqueue('alerts', { data: [] }, { data: [] });
    await fetchAlerts();
    h.fake.enqueue('alerts', { data: [{ id: 'live-1', created_at: '2026-01-01T00:00:00Z' }] });
    const [a] = await fetchAlerts();
    expect(a.id).toBe('live-1');
    expect(isAlertFallbackActive()).toBe(false);
  });

  it('falls back to the simulated watchlist when blacklist_entries is empty', async () => {
    h.fake.enqueue('blacklist_entries', { data: [] });
    expect(await fetchBlacklistEntries()).toBe(mockBlacklistEntries);
    expect(isWatchlistFallbackActive()).toBe(true);
    h.fake.enqueue('blacklist_entries', { data: [{ id: 'bl-live', plate_text: 'MH01AB1234', created_at: 't' }] });
    const [e] = await fetchBlacklistEntries();
    expect(e.id).toBe('bl-live');
    expect(isWatchlistFallbackActive()).toBe(false);
  });

  it('maps rows from the plain-select fallback', async () => {
    h.fake.enqueue('alerts', { error: { message: 'join failed' } }, { data: [{ id: 'z', priority: 'low', created_at: 't' }] });
    const [a] = await fetchAlerts();
    expect(a).toMatchObject({ id: 'z', priority: 'low', acknowledged: false });
  });

  it('rejects (for ErrorState) when the client throws', async () => {
    h.fake.enqueue('alerts', new Error('network down'));
    await expect(fetchAlerts()).rejects.toThrow('network down');
  });

  // Regression: a genuine coordinate of 0 used to be replaced by the default location (`||`).
  it('preserves lat/lng of 0 instead of substituting defaults', async () => {
    h.fake.enqueue('alerts', { data: [{ id: 'a', detections: { lat: 0, lng: 0 } }] });
    const [a] = await fetchAlerts();
    expect(a.lat).toBe(0);
  });

  it('acknowledgeAlert throws with the DB error message', async () => {
    h.fake.enqueue('alerts', { error: { message: 'denied' } });
    await expect(acknowledgeAlert('a1')).rejects.toThrow('Failed to acknowledge alert: denied');
  });

  // Regression: operatorName used to be dropped in DB mode. (The RLS trigger
  // re-stamps acknowledged_by from the JWT server-side; sending it keeps
  // non-RLS/older databases correct.)
  it('acknowledgeAlert persists status + acknowledged_by in DB mode', async () => {
    h.fake.enqueue('alerts', { data: null });
    await acknowledgeAlert('a1', 'Officer X');
    const payload = h.fake.opsFor(h.fake.calls[0], 'update')[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({ status: 'acknowledged', acknowledged: true, acknowledged_by: 'Officer X' });
  });

  it('maps anomaly alert_type and camera code from joined rows', () => {
    const a = rowToAlert({ id: 'x', alert_type: 'cloned_plate', status: 'open', detections: { cameras: { code: 'DD-01', name: 'Dadar' } } });
    expect(a).toMatchObject({ kind: 'cloned_plate', camera_code: 'DD-01', camera_name: 'Dadar', acknowledged: false });
  });

  it('createWatchlistEntry inserts plate/notes and maps the stored row', async () => {
    h.fake.enqueue('blacklist_entries', { data: { id: 'bl-1', plate_text: 'MH 01 AB 1234', notes: 'why', category: 'wanted', priority: 'high', created_at: 'c' } });
    const e = await createWatchlistEntry({ plate_text: 'MH 01 AB 1234', category: 'wanted', priority: 'high', reason: 'why', valid_to: null });
    expect(e).toMatchObject({ id: 'bl-1', plate_text: 'MH 01 AB 1234', reason: 'why' });
    const payload = h.fake.opsFor(h.fake.calls[0], 'insert')[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({ plate_text: 'MH 01 AB 1234', reason: 'why', notes: 'why', is_active: true });
  });

  it('updateWatchlistEntry throws the RLS error for anonymous writes', async () => {
    h.fake.enqueue('blacklist_entries', { error: { message: 'permission denied for table blacklist_entries' } });
    await expect(updateWatchlistEntry('bl-1', { is_active: false })).rejects.toThrow('permission denied');
  });

  it('fetchBlacklistEntries maps rows and throws on error', async () => {
    h.fake.enqueue('blacklist_entries', {
      data: [{ id: 'b', plate_text: 'MH1', created_at: 'c', is_active: false }],
    });
    const [b] = await fetchBlacklistEntries();
    expect(b).toMatchObject({ id: 'b', plate_text: 'MH1', category: 'stolen', priority: 'high', is_active: false, valid_to: null, updated_at: 'c' });

    h.fake.enqueue('blacklist_entries', { error: { message: 'rls' } });
    await expect(fetchBlacklistEntries()).rejects.toThrow('Failed to fetch blacklist entries: rls');
  });
});

describe('alerts — schema contract against ALL supabase/migrations (in apply order)', () => {
  // Formerly schema drift (init migration only): fixed by 20261001000000_reconcile_schema.sql.
  it('alerts table has the columns alerts api.ts reads/writes', () => {
    const cols = tableColumns('alerts');
    expect(cols).toEqual(expect.arrayContaining(['created_at', 'status', 'detection_id', 'acknowledged', 'acknowledged_by', 'acknowledged_at', 'alert_type']));
  });

  it('blacklist_entries has the columns written by the dashboard and seed_alerts_and_watchlist.py', () => {
    const cols = tableColumns('blacklist_entries');
    expect(cols).toEqual(expect.arrayContaining(['plate_text', 'plate_text_normalized', 'notes', 'reason', 'is_active', 'valid_to', 'source']));
  });
});

describe('alerts — replay the day (simulated mode)', () => {
  afterEach(() => resetReplay());

  it('only returns alerts that have fired by the replay clock, un-acknowledging later acks', async () => {
    startReplay('08:06:00');
    stopReplay();
    const at = istOnDay('08:06:00');
    const visible = simAlertsAt(at);
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThan(mockAlerts.length);
    for (const a of visible) {
      expect(Date.parse(a.timestamp)).toBeLessThanOrEqual(at);
      if (a.acknowledged && a.acknowledged_at && !a.acknowledged_by?.startsWith('Tester')) expect(Date.parse(a.acknowledged_at)).toBeLessThanOrEqual(at);
    }
  });

  it('fetchAlerts follows the replay clock while replay is active', async () => {
    startReplay('08:06:00');
    const during = await fetchAlerts();
    stopReplay();
    const after = await fetchAlerts();
    expect(during.length).toBeLessThan(after.length);
    expect(after).toBe(mockAlerts);
  });
});
