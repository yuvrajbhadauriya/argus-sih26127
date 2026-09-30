import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeDataApi, fail, rows } from '@/test/dataApiMock';

const h = vi.hoisted(() => ({ configured: true }));

vi.mock('@/lib/supabase/client', () => ({
  getSupabase: async () => {
    throw new Error('the browser must not query tables directly');
  },
  isSupabaseConfigured: () => h.configured,
  getAccessToken: async () => 'op-token',
}));

import { fetchAuditLog } from './api';
import { resetAuth } from '@/features/auth/session';
import { mockAuditLogs } from '@/mocks/fixtures/mockAdmin';

const OPERATOR = { id: 'u1', email: 'op@example.com', name: 'Op', role: 'operator' as const, demo: false };
const api = createFakeDataApi();

beforeEach(() => {
  h.configured = true;
  api.reset();
  vi.stubGlobal('fetch', api.fetch);
  resetAuth(null);
});

afterEach(() => vi.unstubAllGlobals());

describe('fetchAuditLog', () => {
  it('never calls the API for a guest and shows the simulated trail', async () => {
    const t = await fetchAuditLog();
    expect(api.fetch).not.toHaveBeenCalled();
    expect(t).toEqual({ entries: mockAuditLogs, simulated: true, reason: 'guest' });
  });

  it('signed in + empty table → simulated trail flagged "empty"', async () => {
    resetAuth(OPERATOR);
    api.enqueue('audit-log', rows([]));
    expect(await fetchAuditLog()).toMatchObject({ simulated: true, reason: 'empty' });
  });

  it('signed in + rows → live entries, requested with the operator token', async () => {
    resetAuth(OPERATOR);
    api.enqueue('audit-log', rows([{ id: 7, action: 'ALERT_ACK', entity_type: 'alert', entity_id: 'a1', user_id: 'u1', details: { x: 1 }, created_at: 't' }]));
    const t = await fetchAuditLog(50);
    expect(t.simulated).toBe(false);
    expect(t.entries[0]).toMatchObject({ id: '7', user_email: 'u1', details: '{"x":1}', timestamp: 't' });
    expect(api.calls[0].headers.get('authorization')).toBe('Bearer op-token');
    expect(api.calls[0].params.get('limit')).toBe('50');
  });

  it('signed in without an operator role (403) → the guest view', async () => {
    resetAuth(OPERATOR);
    api.enqueue('audit-log', fail(403, 'Operator or admin role required'));
    expect(await fetchAuditLog()).toEqual({ entries: mockAuditLogs, simulated: true, reason: 'guest' });
  });

  it('signed in + API error → rejects (page shows ErrorState)', async () => {
    resetAuth(OPERATOR);
    api.enqueue('audit-log', fail(502, 'boom'));
    await expect(fetchAuditLog()).rejects.toThrow('boom');
  });

  it('not configured → simulated trail', async () => {
    h.configured = false;
    expect(await fetchAuditLog()).toEqual({ entries: mockAuditLogs, simulated: true });
  });
});
