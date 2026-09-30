// Pure helpers for the alert triage queue (unit-tested).

import type { AlertRecord } from '@/types';
import { SEVERITY_ORDER } from '@/shared/ui/SeverityChip';

/** Severity first (critical → low), then newest first. */
export function sortForTriage<T extends AlertRecord>(alerts: T[]): T[] {
  return [...alerts].sort(
    (a, b) => SEVERITY_ORDER[a.priority] - SEVERITY_ORDER[b.priority] || Date.parse(b.timestamp) - Date.parse(a.timestamp),
  );
}

/** Median seconds from alert to acknowledgement, or null when none are timed. */
export function medianAckSeconds(alerts: AlertRecord[]): number | null {
  const d = alerts
    .filter((a) => a.acknowledged && a.acknowledged_at)
    .map((a) => (Date.parse(a.acknowledged_at!) - Date.parse(a.timestamp)) / 1000)
    .filter((s) => Number.isFinite(s) && s >= 0)
    .sort((x, y) => x - y);
  if (d.length === 0) return null;
  const m = Math.floor(d.length / 2);
  return d.length % 2 ? d[m] : (d[m - 1] + d[m]) / 2;
}

/** "5 min ago", "3 h ago", "2 d ago". */
export function relativeTime(iso: string, now = Date.now()): string {
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return '';
  if (s < 0) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** Ids present in `next` but not in `prev` (newly arrived while polling). */
export function newAlertIds(prev: AlertRecord[], next: AlertRecord[]): string[] {
  const seen = new Set(prev.map((a) => a.id));
  return next.filter((a) => !seen.has(a.id)).map((a) => a.id);
}
