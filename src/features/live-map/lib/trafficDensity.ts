// ═══════════════════════════════════════════════════
// Traffic density at each camera, from the camera's own analytics: the per-frame
// overlay rows of public/detections/detections_<CAM>.json (tracked_vehicle_id +
// frame_timestamp_sec, 5 fps).
//
// Traffic = number of DISTINCT tracked vehicles in a sliding window (default 5 s)
// ending at the camera's replay time. The replay time is the same clock as the
// recorded-reads feed: clip time = live clock modulo the clip length
// (features/cameras/lib/liveClock.ts), so the windows wrap around at the clip end.
// This is traffic seen by the camera feeds (recorded clips replayed on a live
// clock) - not city-wide road traffic.
// ═══════════════════════════════════════════════════

import { livePosition } from '@/features/cameras/lib/liveClock';

export const TRAFFIC_WINDOW_SEC = 5;

export const TRAFFIC_LABEL = 'Traffic density from the camera feeds: vehicles in view, recorded clips replayed on a live clock';

export interface TrafficSample {
  /** Clip time (s). */
  t: number;
  id: string;
}

export interface TrafficIndex {
  /** Samples sorted by time. */
  samples: TrafficSample[];
  /** Clip length (s) the window wraps around. */
  duration: number;
  /** Most vehicles seen in any window of the clip (the busiest observed window). */
  peak: number;
}

export type TrafficLevel = 'Light' | 'Moderate' | 'Heavy';

export interface TrafficReading {
  code: string;
  /** Distinct vehicles in the window (raw count). */
  count: number;
  /** count / busiest observed window across all cameras, 0..1. */
  intensity: number;
  level: TrafficLevel;
  windowSec: number;
}

/** Clip time (s) of a row: tolerant of missing / malformed fields (such rows are ignored). */
function sample(row: unknown): TrafficSample | null {
  const r = row as { tracked_vehicle_id?: unknown; frame_timestamp_sec?: unknown } | null;
  const t = r?.frame_timestamp_sec;
  if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) return null;
  const id = r?.tracked_vehicle_id;
  if (typeof id !== 'string' && typeof id !== 'number') return null;
  return { t, id: String(id) };
}

/** Distinct vehicles with a sample in (clipTime - windowSec, clipTime], wrapping around the clip end. */
export function countInWindow(index: Pick<TrafficIndex, 'samples' | 'duration'>, clipTime: number, windowSec = TRAFFIC_WINDOW_SEC): number {
  const { samples, duration } = index;
  if (!samples.length || !(duration > 0) || !(windowSec > 0)) return 0;
  const end = ((clipTime % duration) + duration) % duration;
  const start = end - windowSec;
  const ids = new Set<string>();
  for (const s of samples) {
    const inMain = s.t > start && s.t <= end;
    // the part of the window before clip time 0 is the tail of the clip
    const inWrap = start < 0 && s.t > start + duration;
    if (inMain || inWrap) ids.add(s.id);
  }
  return ids.size;
}

/**
 * Index of one camera's overlay rows. `durationSec` is the clip length used by the live clock
 * (events file); without it the clip is taken to end one frame step after the last sample.
 */
export function buildTrafficIndex(rows: unknown, durationSec?: number | null, windowSec = TRAFFIC_WINDOW_SEC): TrafficIndex | null {
  if (!Array.isArray(rows)) return null;
  const samples = rows.map(sample).filter((s): s is TrafficSample => s !== null).sort((a, b) => a.t - b.t);
  if (!samples.length) return null;
  const last = samples[samples.length - 1].t;
  const duration = durationSec && durationSec > last ? durationSec : last + 0.2;
  const index = { samples, duration, peak: 0 };
  // busiest observed window: windows ending at every distinct sample time
  let peak = 0;
  for (const t of new Set(samples.map((s) => s.t))) peak = Math.max(peak, countInWindow(index, t, windowSec));
  return { ...index, peak };
}

export function trafficLevel(intensity: number): TrafficLevel {
  return intensity < 1 / 3 ? 'Light' : intensity < 2 / 3 ? 'Moderate' : 'Heavy';
}

/**
 * Traffic at every camera with data, at wall-clock `nowMs`. Intensity is normalised by the busiest observed
 * window of ALL cameras (that window = 1), so differences between cameras stay visible.
 */
export function trafficAt(indices: ReadonlyMap<string, TrafficIndex>, nowMs: number, windowSec = TRAFFIC_WINDOW_SEC): Map<string, TrafficReading> {
  let peak = 0;
  for (const i of indices.values()) peak = Math.max(peak, i.peak);
  const out = new Map<string, TrafficReading>();
  for (const [code, index] of indices) {
    const clipTime = livePosition(code, index.duration, nowMs);
    const count = countInWindow(index, clipTime, windowSec);
    const intensity = peak > 0 ? Math.min(1, count / peak) : 0;
    out.set(code, { code, count, intensity, level: trafficLevel(intensity), windowSec });
  }
  return out;
}

/** Glow colours for an intensity: green (light) -> amber -> red (heavy); weaker and more transparent when light. */
export function heatColors(intensity: number): { core: string; mid: string; hue: number } {
  const k = Math.max(0, Math.min(1, intensity));
  const hue = Math.round(120 * (1 - k));
  const alpha = 0.12 + 0.6 * k;
  return { hue, core: `hsl(${hue} 90% 48% / ${alpha.toFixed(2)})`, mid: `hsl(${hue} 90% 48% / ${(alpha * 0.45).toFixed(2)})` };
}
