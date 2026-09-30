// ═══════════════════════════════════════════════════
// Live alert events — one tiny in-memory bus for "an alert just happened".
//
// Producers: Supabase Realtime (./realtime.ts, live mode) and the replay
// engine (src/features/replay/engine.ts, simulated mode).
// Consumers: LiveAlertBridge (toast + sidebar badge) and the Alerts page
// (merges the row into the queue without waiting for the 30 s poll).
// ═══════════════════════════════════════════════════

import type { TriageAlert } from './types';

export type AlertEventType = 'insert' | 'update';
export type AlertEventSource = 'realtime' | 'replay';

export interface AlertEvent {
  type: AlertEventType;
  alert: TriageAlert;
  source: AlertEventSource;
}

const listeners = new Set<(e: AlertEvent) => void>();

export function emitAlertEvent(e: AlertEvent): void {
  listeners.forEach((l) => l(e));
}

export function subscribeAlertEvents(cb: (e: AlertEvent) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Merge an event into a list (insert → prepend if new; update → patch in place). */
export function applyAlertEvent<T extends TriageAlert>(list: T[], e: AlertEvent): T[] {
  const i = list.findIndex((a) => a.id === e.alert.id);
  if (e.type === 'insert') return i >= 0 ? list : [e.alert as T, ...list];
  if (i < 0) return list;
  const next = list.slice();
  next[i] = { ...next[i], acknowledged: e.alert.acknowledged, acknowledged_by: e.alert.acknowledged_by, acknowledged_at: e.alert.acknowledged_at };
  return next;
}

// ── realtime connection status (for the top-bar status popover) ──

export type LiveChannelStatus = 'off' | 'connecting' | 'subscribed' | 'error';
let channelStatus: LiveChannelStatus = 'off';
const statusListeners = new Set<() => void>();

export function setLiveChannelStatus(s: LiveChannelStatus): void {
  if (s === channelStatus) return;
  channelStatus = s;
  statusListeners.forEach((l) => l());
}

export function getLiveChannelStatus(): LiveChannelStatus {
  return channelStatus;
}

export function subscribeLiveChannelStatus(cb: () => void): () => void {
  statusListeners.add(cb);
  return () => statusListeners.delete(cb);
}
