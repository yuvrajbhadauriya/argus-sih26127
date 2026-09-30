// ═══════════════════════════════════════════════════
// Live Map data access — simulated city-network summary.
// /sim/summary.json is produced by the simulation pipeline (static asset).
// The response is cached for the session and concurrent calls share one
// request; failures are not cached so a retry refetches.
// ═══════════════════════════════════════════════════

export interface SimSummaryStats {
  vehicles: number;
  journeys: number;
  sightings: number;
  multi_camera_journeys?: number;
  total_distance_km?: number;
  hop_speed_kmph: { mean: number; p10?: number; p50?: number; p90?: number; min?: number; max?: number };
  sightings_per_camera?: Record<string, number>;
  /** 24 entries, index = IST hour of day */
  sightings_per_hour: number[];
}

export interface SimSummary {
  simulated: boolean;
  date?: string;
  timezone?: string;
  stats: SimSummaryStats;
}

let cached: SimSummary | null = null;
let inflight: Promise<SimSummary> | null = null;

function isSummary(v: unknown): v is SimSummary {
  const s = (v as SimSummary | null)?.stats;
  return !!s && typeof s.vehicles === 'number' && Array.isArray(s.sightings_per_hour) && typeof s.hop_speed_kmph?.mean === 'number';
}

/** Fetch (once) the simulation summary. Rejects on HTTP or shape errors. */
export function fetchSimSummary(): Promise<SimSummary> {
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  const p = fetch('/sim/summary.json')
    .then(async (res) => {
      if (!res.ok) throw new Error(`Simulation summary unavailable (HTTP ${res.status})`);
      const json: unknown = await res.json();
      if (!isSummary(json)) throw new Error('Simulation summary has an unexpected shape');
      cached = json;
      return json;
    })
    .finally(() => {
      if (inflight === p) inflight = null;
    });
  inflight = p;
  return p;
}

/** Test helper: forget the cached summary. */
export function clearSimSummaryCache(): void {
  cached = null;
  inflight = null;
}
