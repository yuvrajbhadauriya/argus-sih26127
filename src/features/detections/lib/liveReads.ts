// ═══════════════════════════════════════════════════
// Live plate reads — the REAL model reads on each camera's clip, replayed on
// the camera's virtual live clock (features/cameras/lib/liveClock.ts).
//
// A clip loops forever on that clock; every time the clock passes an event's
// `time_sec`, that read "happens" again and is stamped with the wall-clock
// time it occurred. Merged over all cameras this is a continuous, looping
// stream of genuine reads — the same instants the video overlay shows them.
// Only good reads (OCR ≥ 75 % + valid plate grammar) are included.
// ═══════════════════════════════════════════════════

import { liveClockSeconds } from '@/features/cameras/lib/liveClock';
import { isDisplayableRead, type CameraEvents, type PlateEvent } from '../api';

export interface LiveRead {
  /** Unique per occurrence: camera · loop number · event index (a track can have several reads). */
  key: string;
  camera_code: string;
  event: PlateEvent;
  /** Wall-clock time (ms) at which the read occurred on the live clock. */
  at: number;
}

export interface LiveReadOptions {
  /** Max reads returned (newest first). */
  limit?: number;
  /** Ignore reads older than this many seconds. */
  maxAgeSec?: number;
  /** Clip loops to look back through (default: enough to fill `limit`, max 50). */
  maxLoops?: number;
}

/** Good reads of one camera, sorted by clip time (cached per events object). */
const goodCache = new WeakMap<CameraEvents, PlateEvent[]>();
export function goodReads(cam: CameraEvents): PlateEvent[] {
  let g = goodCache.get(cam);
  if (!g) {
    g = cam.events.filter(isDisplayableRead).sort((a, b) => a.time_sec - b.time_sec);
    goodCache.set(cam, g);
  }
  return g;
}

/** Clip length used by the live clock for this camera (events file, else the last read + 1 s). */
export function clockDuration(cam: CameraEvents): number {
  if (cam.duration_sec && cam.duration_sec > 0) return cam.duration_sec;
  const last = cam.events.reduce((m, e) => Math.max(m, e.time_sec), 0);
  return last + 1;
}

/** Most recent reads of one camera up to `nowMs`, newest first. */
export function recentCameraReads(cam: CameraEvents, nowMs: number, opts: LiveReadOptions = {}): LiveRead[] {
  const { limit = 20, maxAgeSec = Number.POSITIVE_INFINITY, maxLoops = 50 } = opts;
  const reads = goodReads(cam);
  if (reads.length === 0 || limit <= 0) return [];
  const dur = clockDuration(cam);
  const T = liveClockSeconds(cam.camera_code, nowMs);
  const k = Math.floor(T / dur);
  const out: LiveRead[] = [];
  for (let loop = k; loop > k - maxLoops && out.length < limit; loop--) {
    for (let i = reads.length - 1; i >= 0 && out.length < limit; i--) {
      const e = reads[i];
      const occ = loop * dur + e.time_sec;
      if (occ > T) continue;
      const age = T - occ;
      if (age > maxAgeSec) return out;
      out.push({ key: `${cam.camera_code}-${loop}-${i}-${e.tracked_vehicle_id}`, camera_code: cam.camera_code, event: e, at: nowMs - age * 1000 });
    }
  }
  return out;
}

/** Newest reads across cameras, merged newest first. */
export function recentNetworkReads(cams: CameraEvents[], nowMs: number, opts: LiveReadOptions = {}): LiveRead[] {
  const limit = opts.limit ?? 20;
  const all = cams.flatMap((c) => recentCameraReads(c, nowMs, { ...opts, limit }));
  return all.sort((a, b) => b.at - a.at).slice(0, limit);
}
