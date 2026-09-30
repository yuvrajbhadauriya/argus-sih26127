// ═══════════════════════════════════════════════════
// Data Access Layer — Admin (audit trail)
//
// Live: `audit_logs` is written only by the server-side audit trigger
// (supabase/migrations/20261001000100_rls.sql) and readable by operators and
// admins — anonymous visitors get an empty list from RLS.
// Simulated / demo: the fixture audit trail of the simulated day.
// ═══════════════════════════════════════════════════

import type { AuditLogEntry } from '@/types';
import { getSupabase, isSupabaseConfigured } from '@/lib/supabase/client';
import { mockAuditLogs } from '@/mocks/fixtures/mockAdmin';

export async function fetchAuditLog(limit = 500): Promise<AuditLogEntry[]> {
  if (!isSupabaseConfigured()) return mockAuditLogs;
  const supabase = await getSupabase();
  const { data, error } = await supabase.from('audit_logs').select('*').order('timestamp', { ascending: false }).limit(limit);
  if (error) throw new Error(`Failed to load the audit trail: ${error.message}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data ?? []).map((r: any) => ({
    id: String(r.id),
    action: r.action,
    entity_type: r.entity_type,
    entity_id: r.entity_id,
    user_id: r.user_id,
    user_email: r.user_email || r.user_id,
    details: typeof r.details === 'string' ? r.details : JSON.stringify(r.details),
    timestamp: r.timestamp ?? r.created_at,
  }));
}
