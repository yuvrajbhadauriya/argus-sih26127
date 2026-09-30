// ═══════════════════════════════════════════════════
// Live alerts (live mode) — polls GET /api/data/alerts every 10 s.
//
// The database is private (no anon Realtime), so new alerts are discovered by
// polling the server API (CDN-cached for 5 s, so all viewers share one query).
// The first answer is the baseline; afterwards every unseen id is emitted as
// an `insert` (toast + badge + Alerts queue) and every acknowledgement change
// as an `update`. Paused while the tab is hidden; refreshed when it returns.
// ═══════════════════════════════════════════════════

import { isSupabaseConfigured } from '@/lib/supabase/client';
import { apiRows } from '@/lib/dataApi';
import { rowToAlert } from './api';
import { emitAlertEvent } from './live';
import type { TriageAlert } from './types';

import type { LiveChannelStatus } from './live';

export const ALERTS_POLL_MS = 10_000;
/** At most this many insert events (toasts) per poll, newest first. */
export const MAX_INSERTS_PER_POLL = 5;

/**
 * Start polling. Returns a stop function. `onStatus` reports the feed state
 * (for the status popover): connecting → subscribed, or error.
 */
export function subscribeAlertsLive(onStatus?: (s: LiveChannelStatus) => void, intervalMs = ALERTS_POLL_MS): () => void {
  if (!isSupabaseConfigured()) {
    onStatus?.('off');
    return () => {};
  }
  let active = true;
  let inFlight = false;
  let known: Map<string, TriageAlert> | null = null;
  onStatus?.('connecting');

  const poll = async () => {
    if (inFlight || (known && typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
    inFlight = true;
    try {
      const alerts = (await apiRows('alerts')).map(rowToAlert);
      if (!active) return;
      if (known) {
        const prev = known;
        const inserts = alerts.filter((a) => !prev.has(a.id)).slice(0, MAX_INSERTS_PER_POLL);
        for (const a of inserts.reverse()) emitAlertEvent({ type: 'insert', alert: a, source: 'live' });
        for (const a of alerts) {
          const p = prev.get(a.id);
          if (p && (p.acknowledged !== a.acknowledged || p.acknowledged_by !== a.acknowledged_by)) {
            emitAlertEvent({ type: 'update', alert: a, source: 'live' });
          }
        }
      }
      known = new Map(alerts.map((a) => [a.id, a]));
      onStatus?.('subscribed');
    } catch {
      if (active) onStatus?.('error');
    } finally {
      inFlight = false;
    }
  };

  void poll();
  const timer = setInterval(() => void poll(), intervalMs);
  const onVisible = () => {
    if (document.visibilityState === 'visible') void poll();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);

  return () => {
    active = false;
    clearInterval(timer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
  };
}
