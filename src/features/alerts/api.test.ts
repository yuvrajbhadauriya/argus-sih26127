import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeDataApi, fail, row, rows } from '@/test/dataApiMock';
import { tableColumns } from '@/test/migrations';

const h = vi.hoisted(() => ({ configured: false, token: 'op-token' as string | null }));

vi.mock('@/lib/supabase/client', () => ({
  getSupabase: async () => {
    throw new Error('the browser must not query tables directly');
  },
  isSupabaseConfigured: () => h.configured,
  getAccessToken: async () => h.token,
}));

const api = createFakeDataApi();

import { fetchAlerts, fetchAlertById, acknowledgeAlert, fetchBlacklistEntries, simAlertsAt, createWatchlistEntry, updateWatchlistEntry, rowToAlert, isAlertFallbackActive, isWatchlistFallbackActive } from './api';
import { resetReplay, startReplay, stopReplay, istOnDay } from '@/features/replay/clock';
import { mockAlertFeed as mockAlerts, mockBlacklistEntries } from '@/mocks/fixtures/mockAlerts';

beforeEach(() => {
  h.configured = false;
  h.token = 'op-token';
  api.reset();
  vi.stubGlobal('fetch', api.fetch);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => vi.unstubAllGlobals());

describe('alerts — mock mode', () => {
  it('fetchAlerts returns mock alerts without touching the client', async () => {
    expect(await fetchAlerts()).toBe(mockAlerts);
    expect(api.fetch).not.toHaveBeenCalled();
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

describe('alerts — live (via /api/data, mocked)', () => {
  beforeEach(() => {
    h.configured = true;
  });

  it('maps joined alert rows (detections → cameras, blacklist_entries)', async () => {
    api.enqueue(
      'alerts',
      rows([
        {
          id: 'a1',
          detection_id: 'd1',
          blacklist_entry_id: 'b1',
          status: 'acknowledged',
          created_at: '2026-01-01T00:00:00Z',
          detections: { event_id: 'd1', camera_id: 'cam-002', plate_text_raw: 'MH 01 AB 1234', lat: 10, lng: 20, cameras: { name: 'CP' } },
          blacklist_entries: { id: 'b1', priority: 'critical', category: 'wanted', notes: 'n' },
        },
      ]),
    );
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
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]).toMatchObject({ route: 'alerts', method: 'GET' });
    expect(api.calls[0].headers.get('authorization')).toBeNull();
  });

  it('surfaces an API error (never mocks)', async () => {
    api.enqueue('alerts', fail(502, 'Database request failed (HTTP 500)'));
    await expect(fetchAlerts()).rejects.toThrow('Failed to load alerts: Database request failed (HTTP 500)');
  });

  it('falls back to the simulated feed (tagged simulated) when the table is empty', async () => {
    api.enqueue('alerts', rows([]));
    const alerts = await fetchAlerts();
    expect(alerts.length).toBe(mockAlerts.length);
    expect(alerts.every((a) => (a as { simulated?: boolean }).simulated)).toBe(true);
    expect(isAlertFallbackActive()).toBe(true);
  });

  it('acknowledges a simulated fallback alert locally (no database write)', async () => {
    api.enqueue('alerts', rows([]));
    const [first] = await fetchAlerts();
    const before = api.calls.length;
    await acknowledgeAlert(first.id, 'Operator');
    expect(api.calls.length).toBe(before);
    expect(mockAlerts.find((a) => a.id === first.id)?.acknowledged).toBe(true);
  });

  it('shows real rows again (fallback off) once the table has alerts', async () => {
    api.enqueue('alerts', rows([]));
    await fetchAlerts();
    api.enqueue('alerts', rows([{ id: 'live-1', created_at: '2026-01-01T00:00:00Z' }]));
    const [a] = await fetchAlerts();
    expect(a.id).toBe('live-1');
    expect(isAlertFallbackActive()).toBe(false);
  });

  it('falls back to the simulated watchlist when blacklist_entries is empty', async () => {
    api.enqueue('watchlist', rows([]));
    expect(await fetchBlacklistEntries()).toBe(mockBlacklistEntries);
    expect(isWatchlistFallbackActive()).toBe(true);
    api.enqueue('watchlist', rows([{ id: 'bl-live', plate_text: 'MH01AB1234', created_at: 't' }]));
    const [e] = await fetchBlacklistEntries();
    expect(e.id).toBe('bl-live');
    expect(isWatchlistFallbackActive()).toBe(false);
  });

  it('maps un-joined rows (server fell back to a plain select)', async () => {
    api.enqueue('alerts', rows([{ id: 'z', priority: 'low', created_at: 't' }]));
    const [a] = await fetchAlerts();
    expect(a).toMatchObject({ id: 'z', priority: 'low', acknowledged: false });
  });

  it('rejects (for ErrorState) when the network fails', async () => {
    api.enqueue('alerts', new TypeError('network down'));
    await expect(fetchAlerts()).rejects.toThrow('Data API is unreachable');
  });

  // Regression: a genuine coordinate of 0 used to be replaced by the default location (`||`).
  it('preserves lat/lng of 0 instead of substituting defaults', async () => {
    api.enqueue('alerts', rows([{ id: 'a', detections: { lat: 0, lng: 0 } }]));
    const [a] = await fetchAlerts();
    expect(a.lat).toBe(0);
  });

  it('fetchAlertById reads one row', async () => {
    api.enqueue('alerts', row({ id: 'a7', status: 'open' }));
    expect(await fetchAlertById('a7')).toMatchObject({ id: 'a7' });
    expect(api.calls[0].params.get('id')).toBe('a7');
  });

  it('acknowledgeAlert throws with the API error message', async () => {
    api.enqueue('alerts/acknowledge', fail(403, 'Operator or admin role required'));
    await expect(acknowledgeAlert('a1')).rejects.toThrow('Failed to acknowledge alert: Operator or admin role required');
  });

  it('acknowledgeAlert needs a session (no request without a token)', async () => {
    h.token = null;
    await expect(acknowledgeAlert('a1')).rejects.toThrow('Sign in as an operator');
    expect(api.calls).toHaveLength(0);
  });

  // The server stamps acknowledged_by from the verified session; the client
  // only names the alert and sends the operator's access token.
  it('acknowledgeAlert POSTs the id with the bearer token', async () => {
    api.enqueue('alerts/acknowledge', row({ id: 'a1', status: 'acknowledged' }));
    await acknowledgeAlert('a1', 'Officer X');
    expect(api.calls[0]).toMatchObject({ route: 'alerts/acknowledge', method: 'POST', body: { id: 'a1' } });
    expect(api.calls[0].headers.get('authorization')).toBe('Bearer op-token');
  });

  it('maps anomaly alert_type and camera code from joined rows', () => {
    const a = rowToAlert({ id: 'x', alert_type: 'cloned_plate', status: 'open', detections: { cameras: { code: 'DD-01', name: 'Dadar' } } });
    expect(a).toMatchObject({ kind: 'cloned_plate', camera_code: 'DD-01', camera_name: 'Dadar', acknowledged: false });
  });

  it('createWatchlistEntry posts the entry and maps the stored row', async () => {
    api.enqueue('watchlist', { status: 201, body: { row: { id: 'bl-1', plate_text: 'MH 01 AB 1234', notes: 'why', category: 'wanted', priority: 'high', created_at: 'c' } } });
    const e = await createWatchlistEntry({ plate_text: 'MH 01 AB 1234', category: 'wanted', priority: 'high', reason: 'why', valid_to: null });
    expect(e).toMatchObject({ id: 'bl-1', plate_text: 'MH 01 AB 1234', reason: 'why' });
    expect(api.calls[0]).toMatchObject({ method: 'POST', body: { plate_text: 'MH 01 AB 1234', reason: 'why', category: 'wanted', priority: 'high', valid_to: null } });
  });

  it('updateWatchlistEntry PATCHes by id and surfaces auth errors', async () => {
    api.enqueue('watchlist', row({ id: 'bl-1' }));
    await updateWatchlistEntry('bl-1', { is_active: false });
    expect(api.calls[0]).toMatchObject({ method: 'PATCH', body: { is_active: false } });
    expect(api.calls[0].params.get('id')).toBe('bl-1');
    api.enqueue('watchlist', fail(401, 'Sign in as an operator to do this'));
    await expect(updateWatchlistEntry('bl-1', { is_active: false })).rejects.toThrow('Sign in as an operator');
  });

  it('fetchBlacklistEntries maps rows and throws on error', async () => {
    api.enqueue('watchlist', rows([{ id: 'b', plate_text: 'MH1', created_at: 'c', is_active: false }]));
    const [b] = await fetchBlacklistEntries();
    expect(b).toMatchObject({ id: 'b', plate_text: 'MH1', category: 'stolen', priority: 'high', is_active: false, valid_to: null, updated_at: 'c' });

    api.enqueue('watchlist', fail(502, 'rls'));
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
