import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeSupabase } from '@/test/supabaseMock';

const h = vi.hoisted(() => ({ configured: true, fake: null as unknown as ReturnType<typeof createFakeSupabase> }));

vi.mock('@/lib/supabase/client', async () => {
  const { createFakeSupabase } = await import('@/test/supabaseMock');
  h.fake = createFakeSupabase();
  return { getSupabase: async () => h.fake.client, isSupabaseConfigured: () => h.configured };
});

import { fetchAuditLog } from './api';
import { resetAuth } from '@/features/auth/session';
import { mockAuditLogs } from '@/mocks/fixtures/mockAdmin';

const OPERATOR = { id: 'u1', email: 'op@example.com', name: 'Op', role: 'operator' as const, demo: false };

beforeEach(() => {
  h.configured = true;
  h.fake.reset();
  resetAuth(null);
});

describe('fetchAuditLog', () => {
  it('never queries audit_logs for a guest (anon has no grant) and shows the simulated trail', async () => {
    const t = await fetchAuditLog();
    expect(h.fake.from).not.toHaveBeenCalledWith('audit_logs');
    expect(t).toEqual({ entries: mockAuditLogs, simulated: true, reason: 'guest' });
  });

  it('signed in + empty table → simulated trail flagged "empty"', async () => {
    resetAuth(OPERATOR);
    h.fake.enqueue('audit_logs', { data: [] });
    expect(await fetchAuditLog()).toMatchObject({ simulated: true, reason: 'empty' });
  });

  it('signed in + rows → live entries', async () => {
    resetAuth(OPERATOR);
    h.fake.enqueue('audit_logs', { data: [{ id: 7, action: 'ALERT_ACK', entity_type: 'alert', entity_id: 'a1', user_id: 'u1', details: { x: 1 }, created_at: 't' }] });
    const t = await fetchAuditLog();
    expect(t.simulated).toBe(false);
    expect(t.entries[0]).toMatchObject({ id: '7', user_email: 'u1', details: '{"x":1}', timestamp: 't' });
  });

  it('signed in + query error → rejects (page shows ErrorState)', async () => {
    resetAuth(OPERATOR);
    h.fake.enqueue('audit_logs', { error: { message: 'boom' } });
    await expect(fetchAuditLog()).rejects.toThrow('boom');
  });

  it('not configured → simulated trail', async () => {
    h.configured = false;
    expect(await fetchAuditLog()).toEqual({ entries: mockAuditLogs, simulated: true });
  });
});
