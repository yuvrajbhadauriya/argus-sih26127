// ═══════════════════════════════════════════════════
// AI engine status — data access for public.model_status.
//
// The GPU watchdog upserts row id='gpu-primary' (heartbeat every ~10 s while
// running, ~2 s while starting). The dashboard reads it with the anon key
// (RLS: SELECT only) and follows changes over Realtime; callers also poll
// every 10 s as a fallback. Failures are quiet by design: an unreachable
// engine is a status to display, not an error to log.
// ═══════════════════════════════════════════════════

import { getSupabase, isSupabaseConfigured } from '@/lib/supabase/client';
import { parseModelStatusRow, type ModelStatusRow } from './lib/status';

export const MODEL_STATUS_TABLE = 'model_status';
export const MODEL_STATUS_ID = 'gpu-primary';
export const MODEL_STATUS_POLL_MS = 10_000;

/** The engine row, or null when there is none. Throws on a query error. */
export async function fetchModelStatus(): Promise<ModelStatusRow | null> {
  if (!isSupabaseConfigured()) return null;
  const supabase = await getSupabase();
  const { data, error } = await supabase.from(MODEL_STATUS_TABLE).select('*').eq('id', MODEL_STATUS_ID).maybeSingle();
  if (error) throw new Error(error.message);
  return parseModelStatusRow(data);
}

/**
 * Follow INSERT/UPDATE of the engine row over Realtime. Returns an
 * unsubscribe function. Channel errors are ignored (polling covers them).
 */
export function subscribeModelStatus(onRow: (row: ModelStatusRow) => void): () => void {
  if (!isSupabaseConfigured()) return () => {};
  let cancelled = false;
  let cleanup: (() => void) | null = null;

  getSupabase()
    .then((supabase) => {
      if (cancelled) return;
      const handle = (payload: { new: unknown }) => {
        const row = parseModelStatusRow(payload.new);
        if (row && row.id === MODEL_STATUS_ID) onRow(row);
      };
      const filter = `id=eq.${MODEL_STATUS_ID}`;
      const channel = supabase
        .channel('nero-model-status')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: MODEL_STATUS_TABLE, filter }, handle)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: MODEL_STATUS_TABLE, filter }, handle)
        .subscribe();
      cleanup = () => {
        void supabase.removeChannel(channel);
      };
    })
    .catch(() => {
      /* polling fallback keeps the status current */
    });

  return () => {
    cancelled = true;
    cleanup?.();
  };
}
