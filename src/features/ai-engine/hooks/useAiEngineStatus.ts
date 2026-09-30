// ═══════════════════════════════════════════════════
// useAiEngineStatus — one shared model_status feed for every consumer
// (top bar + Cameras page). The first subscriber starts the fetch and the 5 s
// poll of /api/data/model-status; the last one to leave stops them.
// Components re-render once a second (countdown / uptime / staleness).
// ═══════════════════════════════════════════════════

import { useEffect, useState, useSyncExternalStore } from 'react';
import { isSupabaseConfigured } from '@/lib/supabase/client';
import { fetchModelStatus, MODEL_STATUS_POLL_MS } from '../api';
import { engineView, type EngineView, type ModelStatusRow } from '../lib/status';

interface Store {
  row: ModelStatusRow | null;
  loaded: boolean;
}

let store: Store = { row: null, loaded: false };
const listeners = new Set<() => void>();
let stopFeed: (() => void) | null = null;

function set(next: Partial<Store>) {
  store = { ...store, ...next };
  listeners.forEach((l) => l());
}

function newer(a: ModelStatusRow | null, b: ModelStatusRow): boolean {
  if (!a) return true;
  const ta = Math.max(Date.parse(a.last_heartbeat) || 0, Date.parse(a.updated_at ?? '') || 0);
  const tb = Math.max(Date.parse(b.last_heartbeat) || 0, Date.parse(b.updated_at ?? '') || 0);
  return tb >= ta;
}

function accept(row: ModelStatusRow | null) {
  if (row === null) {
    set({ row: null, loaded: true });
    return;
  }
  // A slow (out-of-order) poll must not overwrite a fresher answer.
  if (newer(store.row, row)) set({ row, loaded: true });
  else if (!store.loaded) set({ loaded: true });
}

function startFeed(): () => void {
  if (!isSupabaseConfigured()) return () => {};
  let active = true;
  const poll = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden' && store.loaded) return;
    fetchModelStatus()
      .then((row) => active && accept(row))
      .catch(() => active && !store.loaded && set({ loaded: true }));
  };
  poll();
  const timer = setInterval(poll, MODEL_STATUS_POLL_MS);
  const onVisible = () => {
    if (document.visibilityState === 'visible') poll();
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    active = false;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (listeners.size === 1 && !stopFeed) stopFeed = startFeed();
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && stopFeed) {
      stopFeed();
      stopFeed = null;
    }
  };
}
const snapshot = () => store;

/** Current engine status view (re-evaluated every second). */
export function useAiEngineStatus(): EngineView {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);
  const configured = isSupabaseConfigured();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!configured) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [configured]);
  return engineView(s.row, now, { configured, loaded: s.loaded });
}

/** Test hook: forget the shared state (does not stop a running feed). */
export function resetAiEngineStore() {
  store = { row: null, loaded: false };
  listeners.forEach((l) => l());
}
