// ═══════════════════════════════════════════════════
// Data Access Layer — Admin (audit trail)
//
// Live: `audit_logs` is written only by the server-side audit trigger
// (supabase/migrations/20261001000100_rls.sql, actor via 20261001000600) and
// served by GET /api/data/audit-log to signed-in operators and admins only
// (the route verifies the session). Guests are never sent to it; they, and
// signed-in users while the table is still empty, see the simulated day's
// trail, flagged `simulated` so the page shows the badge.
// Simulated / demo: the fixture audit trail of the simulated day.
// ═══════════════════════════════════════════════════

import type { AuditLogEntry } from '@/types';
import { isSupabaseConfigured } from '@/lib/supabase/client';
import { apiRows, DataApiError } from '@/lib/dataApi';
import { getAuthState } from '@/features/auth/session';
import { mockAuditLogs } from '@/mocks/fixtures/mockAdmin';

export interface AuditTrail {
  entries: AuditLogEntry[];
  /** Entries are the simulated day's trail, not the database. */
  simulated: boolean;
  /** Why the simulated trail is shown in live mode. */
  reason?: 'guest' | 'empty';
}

export async function fetchAuditLog(limit = 500): Promise<AuditTrail> {
  if (!isSupabaseConfigured()) return { entries: mockAuditLogs, simulated: true };
  if (!getAuthState().user) return { entries: mockAuditLogs, simulated: true, reason: 'guest' };
  let data: unknown[];
  try {
    data = await apiRows('audit-log', { limit }, { auth: true });
  } catch (err) {
    // Signed in without an operator/admin role: same view as a guest.
    if (err instanceof DataApiError && err.status === 403) return { entries: mockAuditLogs, simulated: true, reason: 'guest' };
    throw new Error(`Failed to load the audit trail: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (data.length === 0) return { entries: mockAuditLogs, simulated: true, reason: 'empty' };
  return {
    simulated: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entries: data.map((r: any) => ({
      id: String(r.id),
      action: r.action,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      user_id: r.user_id,
      user_email: r.user_email || r.user_id,
      details: typeof r.details === 'string' ? r.details : JSON.stringify(r.details),
      timestamp: r.timestamp ?? r.created_at,
    })),
  };
}
