// ═══════════════════════════════════════════════════
// useNavBadges — live counts for the shell (unacknowledged alerts).
// The alerts API is imported dynamically so the Supabase client stays out of
// the entry chunk; refreshes every 60 s. Shared module-level cache so the
// Sidebar and TopBar don't each fetch.
// ═══════════════════════════════════════════════════

import { useSyncExternalStore, useEffect } from 'react';

export const NAV_BADGE_REFRESH_MS = 60_000;

interface NavBadges {
  alerts: number;
  criticalAlerts: number;
}

let state: NavBadges = { alerts: 0, criticalAlerts: 0 };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let users = 0;

async function refresh(): Promise<void> {
  try {
    const { fetchAlerts } = await import('@/features/alerts/api');
    const alerts = await fetchAlerts();
    const open = alerts.filter((a) => !a.acknowledged);
    const next = { alerts: open.length, criticalAlerts: open.filter((a) => a.priority === 'critical').length };
    if (next.alerts !== state.alerts || next.criticalAlerts !== state.criticalAlerts) {
      state = next;
      listeners.forEach((l) => l());
    }
  } catch {
    /* keep last known counts */
  }
}

/** Force a refresh (e.g. after acknowledging an alert). */
export function refreshNavBadges(): Promise<void> {
  return refresh();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
const getSnapshot = () => state;

export function useNavBadges(): NavBadges {
  useEffect(() => {
    users += 1;
    if (users === 1) {
      void refresh();
      timer = setInterval(() => void refresh(), NAV_BADGE_REFRESH_MS);
    }
    return () => {
      users -= 1;
      if (users === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
