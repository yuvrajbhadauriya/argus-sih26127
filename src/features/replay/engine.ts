// ═══════════════════════════════════════════════════
// Replay engine — turns replay-clock ticks into simulated events.
//
//  * Alerts: every simulated alert (watchlist hit / route anomaly) whose
//    timestamp the clock passes during a tick is emitted on the live-alert bus
//    (toast + sidebar badge + Alerts queue), exactly as a Supabase Realtime
//    INSERT would be in live mode.
//  * Sightings: every plate read of the simulated day, indexed by time, so the
//    Live Map feed / KPIs show what the network "sees" at the replay clock.
//
// Only active in simulated/demo mode — live mode has real events.
// ═══════════════════════════════════════════════════

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { AlertPriority, PlateColour, VehicleType } from '@/types';
import { isSupabaseConfigured } from '@/lib/supabase/client';
import { mockAlertFeed, mockBlacklistEntries } from '@/mocks/fixtures/mockAlerts';
import { mockCameras } from '@/mocks/fixtures/mockCameras';
import type { LiveFeedEntry } from '@/mocks/fixtures/mockLiveFeed';
import { loadSimNetwork } from '@/features/vehicles/sim';
import { simAlertsAt } from '@/features/alerts/api';
import { emitAlertEvent } from '@/features/alerts/live';
import { subscribeReplay, useReplay } from './clock';

// ── alerts ──────────────────────────────────────

/** Simulated alerts that fire in (from, to] (oldest first). */
export function alertsFiredBetween(from: number, to: number) {
  return mockAlertFeed
    .filter((a) => {
      const t = Date.parse(a.timestamp);
      return t > from && t <= to;
    })
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

let engineStarted = false;

/** Start emitting replay alerts (idempotent). Returns a stop function (tests). */
export function startReplayEngine(): () => void {
  if (engineStarted || isSupabaseConfigured()) return () => {};
  engineStarted = true;
  const unsub = subscribeReplay((prev, next, change) => {
    if (change !== 'tick' || !next.active || next.clock <= prev.clock) return;
    const visible = new Map(simAlertsAt(next.clock).map((a) => [a.id, a]));
    for (const a of alertsFiredBetween(prev.clock, next.clock)) {
      emitAlertEvent({ type: 'insert', alert: visible.get(a.id) ?? a, source: 'replay' });
    }
  });
  return () => {
    unsub();
    engineStarted = false;
  };
}

// ── sightings ───────────────────────────────────

interface SightingRow {
  t: number;
  plate: string;
  camera: string;
  vehicleType: VehicleType;
  plateVariant?: PlateColour;
  id: string;
}

let sightings: SightingRow[] | null = null;
let sightingsPromise: Promise<SightingRow[]> | null = null;
const loadedListeners = new Set<() => void>();

function loadSightings(): Promise<SightingRow[]> {
  sightingsPromise ??= loadSimNetwork()
    .then((net) => {
      const rows: SightingRow[] = [];
      for (const j of net.doc.journeys) {
        j.sightings.forEach(([camera, ts], k) => {
          rows.push({
            t: Date.parse(ts),
            plate: j.plate_text,
            camera,
            vehicleType: j.vehicle_type as VehicleType,
            plateVariant: j.plate_variant as PlateColour | undefined,
            id: `${j.id}-${k}`,
          });
        });
      }
      rows.sort((a, b) => a.t - b.t);
      sightings = rows;
      loadedListeners.forEach((l) => l());
      return rows;
    })
    .catch((err) => {
      sightingsPromise = null;
      throw err;
    });
  return sightingsPromise;
}

/** Index of the first sighting with t > clock. */
function upperBound(rows: SightingRow[], clock: number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].t <= clock) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const CAMERA_NAME = new Map(mockCameras.map((c) => [c.code, c.name]));
const WATCH = new Map<string, AlertPriority>(
  mockBlacklistEntries.filter((w) => w.is_active).map((w) => [w.plate_text.replace(/\s+/g, ''), w.priority]),
);

/** Deterministic pseudo-confidence per read (the simulation has no OCR scores). */
function confidenceOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return 86 + (Math.abs(h) % 13);
}

/** Latest `limit` reads at or before `clock`, newest first, as live-feed rows. */
export function feedAt(rows: SightingRow[], clock: number, limit = 12): LiveFeedEntry[] {
  const end = upperBound(rows, clock);
  const out: LiveFeedEntry[] = [];
  for (let i = end - 1; i >= 0 && out.length < limit; i--) {
    const r = rows[i];
    out.push({
      id: r.id,
      plate: r.plate,
      cameraCode: r.camera,
      cameraName: CAMERA_NAME.get(r.camera) ?? r.camera,
      vehicleType: r.vehicleType,
      plateVariant: r.plateVariant,
      confidence: confidenceOf(r.id),
      secondsAgo: Math.max(0, Math.round((clock - r.t) / 1000)),
      watchlist: WATCH.get(r.plate.replace(/\s+/g, '')) ?? null,
    });
  }
  return out;
}

/** Number of reads in (clock - windowMs, clock]. */
export function readsInWindow(rows: SightingRow[], clock: number, windowMs = 3_600_000): number {
  return upperBound(rows, clock) - upperBound(rows, clock - windowMs);
}

function subscribeLoaded(cb: () => void) {
  loadedListeners.add(cb);
  return () => loadedListeners.delete(cb);
}
const loadedSnap = () => sightings;

export interface ReplayView {
  active: boolean;
  clock: number;
  /** Latest reads (newest first); null until the sightings are loaded. */
  feed: LiveFeedEntry[] | null;
  /** Reads in the last replay hour; null until loaded. */
  readsLastHour: number | null;
  error: string | null;
}

/** Live-map view of the replay: feed + hourly reads at the replay clock. */
export function useReplayView(limit = 12): ReplayView {
  const replay = useReplay();
  const rows = useSyncExternalStore(subscribeLoaded, loadedSnap, loadedSnap);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!replay.active || rows) return;
    let alive = true;
    loadSightings().catch((e: unknown) => alive && setError(e instanceof Error ? e.message : 'Simulation unavailable'));
    return () => {
      alive = false;
    };
  }, [replay.active, rows]);

  // Re-derive at most once per displayed second of replay time.
  const second = Math.floor(replay.clock / 1000);
  return useMemo(() => {
    if (!replay.active || !rows) return { active: replay.active, clock: replay.clock, feed: null, readsLastHour: null, error };
    const clock = second * 1000;
    return { active: true, clock, feed: feedAt(rows, clock, limit), readsLastHour: readsInWindow(rows, clock), error };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replay.active, rows, second, limit, error]);
}

/** Test hook. */
export function resetReplayEngine(): void {
  sightings = null;
  sightingsPromise = null;
  engineStarted = false;
}

