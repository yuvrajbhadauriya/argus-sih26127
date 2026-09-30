import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createFakeSupabase } from '@/test/supabaseMock';

const h = vi.hoisted(() => ({ configured: false, fake: null as unknown as ReturnType<typeof createFakeSupabase> }));

vi.mock('@/lib/supabase/client', async () => {
  const { createFakeSupabase } = await import('@/test/supabaseMock');
  h.fake = createFakeSupabase();
  return { supabase: h.fake.client, isSupabaseConfigured: () => h.configured };
});

import { fetchAlerts, acknowledgeAlert, fetchBlacklistEntries } from './api';
import { mockAlertFeed as mockAlerts, mockBlacklistEntries } from '@/mocks/fixtures/mockAlerts';

const INIT_SQL = readFileSync(resolve(process.cwd(), 'supabase/migrations/20260925_init_schema.sql'), 'utf8');
function tableColumns(table: string): string[] {
  const m = INIT_SQL.match(new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table} \\(([\\s\\S]*?)\\n\\);`));
  if (!m) throw new Error(`table ${table} not found`);
  return m[1]
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((c) => c && /^[a-z_]+$/.test(c));
}

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
          detections: { event_id: 'd1', camera_id: 'cam-002', plate_text_raw: 'DL 01 AB 1234', lat: 10, lng: 20, cameras: { name: 'CP' } },
          blacklist_entries: { id: 'b1', priority: 'critical', category: 'wanted', notes: 'n' },
        },
      ],
    });
    const [a] = await fetchAlerts();
    expect(a).toMatchObject({
      id: 'a1',
      detection_event_id: 'd1',
      plate_text: 'DL 01 AB 1234',
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

  it('falls back to a plain select when the join returns empty, then to mocks on error', async () => {
    h.fake.enqueue('alerts', { data: [] }, { error: { message: 'x' } });
    expect(await fetchAlerts()).toBe(mockAlerts);
    expect(h.fake.calls).toHaveLength(2);
  });

  it('maps rows from the plain-select fallback', async () => {
    h.fake.enqueue('alerts', { error: { message: 'join failed' } }, { data: [{ id: 'z', priority: 'low', created_at: 't' }] });
    const [a] = await fetchAlerts();
    expect(a).toMatchObject({ id: 'z', priority: 'low', acknowledged: false });
  });

  it('returns mock alerts when the client throws', async () => {
    h.fake.enqueue('alerts', new Error('network down'));
    expect(await fetchAlerts()).toBe(mockAlerts);
  });

  // BUG: a genuine coordinate of 0 is replaced with India Gate defaults because of `||`.
  // (src/features/alerts/api.ts:62-63). Low impact for Delhi, but it's a silent data rewrite.
  it.fails('BUG: preserves lat/lng of 0 instead of substituting defaults', async () => {
    h.fake.enqueue('alerts', { data: [{ id: 'a', detections: { lat: 0, lng: 0 } }] });
    const [a] = await fetchAlerts();
    expect(a.lat).toBe(0);
  });

  it('acknowledgeAlert throws with the DB error message', async () => {
    h.fake.enqueue('alerts', { error: { message: 'denied' } });
    await expect(acknowledgeAlert('a1')).rejects.toThrow('Failed to acknowledge alert: denied');
  });

  // BUG: operatorName is accepted but never persisted in DB mode (features/alerts/api.ts:87-93);
  // the audit trail of *who* acknowledged is lost.
  it.fails('BUG: acknowledgeAlert persists acknowledged_by in DB mode', async () => {
    h.fake.enqueue('alerts', { data: null });
    await acknowledgeAlert('a1', 'Officer X');
    const payload = h.fake.opsFor(h.fake.calls[0], 'update')[0][0] as Record<string, unknown>;
    expect(payload.acknowledged_by).toBe('Officer X');
  });

  it('fetchBlacklistEntries maps rows and throws on error', async () => {
    h.fake.enqueue('blacklist_entries', {
      data: [{ id: 'b', plate_text: 'DL1', created_at: 'c', is_active: false }],
    });
    const [b] = await fetchBlacklistEntries();
    expect(b).toMatchObject({ id: 'b', plate_text: 'DL1', category: 'stolen', priority: 'high', is_active: false, valid_to: null, updated_at: 'c' });

    h.fake.enqueue('blacklist_entries', { error: { message: 'rls' } });
    await expect(fetchBlacklistEntries()).rejects.toThrow('Failed to fetch blacklist entries: rls');
  });
});

describe('alerts — schema contract against supabase/migrations', () => {
  // BUG (schema drift): the frontend orders `alerts` by `created_at` and writes a
  // `status` column, but the init migration defines neither (it has `timestamp`
  // and `acknowledged BOOLEAN`). Against a DB built from the migrations, both
  // fetch queries error → UI silently shows mockAlerts, and acknowledge always throws.
  it.fails('BUG: alerts table has the columns alerts api.ts reads/writes (created_at, status, detection_id)', () => {
    const cols = tableColumns('alerts');
    expect(cols).toEqual(expect.arrayContaining(['created_at', 'status', 'detection_id']));
  });

  it.fails('BUG: blacklist_entries has plate_text_normalized/notes as written by seed_alerts_and_watchlist.py', () => {
    const cols = tableColumns('blacklist_entries');
    expect(cols).toEqual(expect.arrayContaining(['plate_text_normalized', 'notes']));
  });
});
