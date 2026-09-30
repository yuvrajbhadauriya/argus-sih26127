// ═══════════════════════════════════════════════════
// Alerts feature — local type extensions (src/types is frozen)
// ═══════════════════════════════════════════════════

import type { AlertRecord } from '@/types';

/** What raised the alert: a watchlist (blacklist) hit or a route anomaly. */
export type AlertKind = 'watchlist' | 'cloned_plate' | 'circling';

/** A sighting that backs up an anomaly alert. */
export interface AlertEvidence {
  camera_code: string;
  timestamp: string;
}

/**
 * AlertRecord plus optional triage metadata. Rows coming from Supabase carry
 * none of the extras, so every field here is optional.
 */
export interface TriageAlert extends AlertRecord {
  kind?: AlertKind;
  camera_code?: string;
  evidence?: AlertEvidence[];
  /** Data comes from the simulated city network (shows the simulation badge). */
  simulated?: boolean;
}

export const ALERT_KIND_LABEL: Record<AlertKind, string> = {
  watchlist: 'Watchlist hit',
  cloned_plate: 'Cloned plate',
  circling: 'Circling',
};

export function alertKind(a: AlertRecord): AlertKind {
  return (a as TriageAlert).kind ?? 'watchlist';
}
