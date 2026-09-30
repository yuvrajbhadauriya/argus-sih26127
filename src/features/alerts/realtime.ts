// ═══════════════════════════════════════════════════
// Supabase Realtime — alerts only.
//
// Subscribes to postgres_changes INSERT/UPDATE on public.alerts (published by
// supabase/migrations/20261001000300_alerts_realtime.sql). `detections` is
// never subscribed to: it is the high-volume table.
// New rows are re-read with their joins (camera, watchlist entry) before being
// emitted; if that fails the bare row is emitted instead.
// The 30 s poll (Alerts page / nav badges) stays as the fallback.
// ═══════════════════════════════════════════════════

import { getSupabase, isSupabaseConfigured } from '@/lib/supabase/client';
import { fetchAlertById, rowToAlert } from './api';
import { emitAlertEvent } from './live';

import type { LiveChannelStatus as RealtimeStatus } from './live';
export type { RealtimeStatus };

/**
 * Start the alerts subscription. Returns an unsubscribe function.
 * `onStatus` reports the channel state (for the status popover).
 */
export function subscribeAlertsRealtime(onStatus?: (s: RealtimeStatus) => void): () => void {
  if (!isSupabaseConfigured()) {
    onStatus?.('off');
    return () => {};
  }
  let cancelled = false;
  let cleanup: (() => void) | null = null;
  onStatus?.('connecting');

  getSupabase()
    .then((supabase) => {
      if (cancelled) return;
      const channel = supabase
        .channel('nero-alerts')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'alerts' }, (payload) => {
          const row = payload.new as Record<string, unknown>;
          fetchAlertById(String(row.id))
            .then((a) => emitAlertEvent({ type: 'insert', alert: a ?? rowToAlert(row), source: 'realtime' }))
            .catch(() => emitAlertEvent({ type: 'insert', alert: rowToAlert(row), source: 'realtime' }));
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'alerts' }, (payload) => {
          emitAlertEvent({ type: 'update', alert: rowToAlert(payload.new), source: 'realtime' });
        })
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') onStatus?.('subscribed');
          else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') onStatus?.('error');
          else if (status === 'CLOSED') onStatus?.('off');
        });
      cleanup = () => {
        void supabase.removeChannel(channel);
      };
    })
    .catch(() => onStatus?.('error'));

  return () => {
    cancelled = true;
    cleanup?.();
  };
}
