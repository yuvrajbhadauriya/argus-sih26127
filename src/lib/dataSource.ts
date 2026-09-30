// ═══════════════════════════════════════════════════
// dataSource — the ONE honest answer to "where is this data coming from?"
//
//   live       VITE_SUPABASE_URL/KEY are set: cameras, alerts, watchlist,
//              detections and trajectories come from Supabase. Failures are
//              surfaced (ErrorState), never replaced by fixtures.
//   simulated  No Supabase: the simulated Mumbai network (public/sim/*.json)
//              plus fixtures generated from it (src/mocks/fixtures).
//   demo       No Supabase and the /sim files could not be loaded: only the
//              bundled demo fixtures are available.
//
// Shown once in the top bar (SystemStatus). Live-mode request failures are
// recorded here so the status popover can say "Live · degraded".
// ═══════════════════════════════════════════════════

import { useSyncExternalStore } from 'react';
import { isSupabaseConfigured } from '@/lib/supabase/client';

export type DataSource = 'live' | 'simulated' | 'demo';

export const DATA_SOURCE_LABEL: Record<DataSource, string> = {
  live: 'Live (Supabase)',
  simulated: 'Simulated network',
  demo: 'Demo fixtures',
};

export const DATA_SOURCE_DESCRIPTION: Record<DataSource, string> = {
  live: 'Cameras, alerts, watchlist and detections are read from the Supabase database.',
  simulated: 'No database configured: a simulated day of traffic on the real Mumbai road network (public/sim) with real camera clips.',
  demo: 'No database configured and the simulation files are unavailable: bundled demo fixtures only.',
};

interface State {
  simUnavailable: boolean;
  /** Last live-mode failure (message + when), cleared by the next success. */
  liveError: { message: string; at: number } | null;
}

let state: State = { simUnavailable: false, liveError: null };
const listeners = new Set<() => void>();

function set(next: Partial<State>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

/** Current data source (see module comment). */
export function getDataSource(): DataSource {
  if (isSupabaseConfigured()) return 'live';
  return state.simUnavailable ? 'demo' : 'simulated';
}

/** The simulation files failed to load (falls back to "demo"). */
export function reportSimUnavailable(): void {
  if (!state.simUnavailable) set({ simUnavailable: true });
}

/** A live (Supabase) request failed. */
export function reportLiveError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  set({ liveError: { message, at: Date.now() } });
}

/** A live (Supabase) request succeeded. */
export function reportLiveOk(): void {
  if (state.liveError) set({ liveError: null });
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
const snapshot = () => state;

export interface DataSourceInfo {
  source: DataSource;
  label: string;
  description: string;
  liveError: State['liveError'];
}

export function useDataSource(): DataSourceInfo {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);
  const source = isSupabaseConfigured() ? 'live' : s.simUnavailable ? 'demo' : 'simulated';
  return { source, label: DATA_SOURCE_LABEL[source], description: DATA_SOURCE_DESCRIPTION[source], liveError: s.liveError };
}

/** Test hook. */
export function resetDataSource(): void {
  state = { simUnavailable: false, liveError: null };
  listeners.forEach((l) => l());
}
