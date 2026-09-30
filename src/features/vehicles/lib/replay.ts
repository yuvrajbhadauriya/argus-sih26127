// ═══════════════════════════════════════════════════
// Journey replay model (pure; unit-tested)
// Maps a compressed replay clock (ms) onto real sighting time and gives the
// vehicle position(s) along the road geometry at any moment. Off-network gaps
// (between trips) are compressed to a fixed short pause.
// ═══════════════════════════════════════════════════

import type { TrajectoryWaypoint } from '@/types';
import { cumulativeM, pointAlong, type LatLngTuple } from './geo';

interface Segment {
  trip: number;
  t0: number;
  t1: number;
  path: LatLngTuple[];
  cum: number[];
}

interface Interval {
  r0: number;
  r1: number;
  t0: number;
  t1: number;
}

export interface ReplayModel {
  start: number;
  end: number;
  duration: number;
  segments: Segment[];
  trips: { trip: number; t0: number; t1: number; at0: LatLngTuple; at1: LatLngTuple }[];
  intervals: Interval[];
  stopTimes: number[];
}

export interface ReplayPosition {
  trip: number;
  at: LatLngTuple;
  bearing: number;
  moving: boolean;
}

export function buildReplayModel(waypoints: TrajectoryWaypoint[], targetMs = 16000, gapMs = 900): ReplayModel {
  const stopTimes = waypoints.map((w) => Date.parse(w.timestamp));
  const segments: Segment[] = [];
  const tripMap = new Map<number, ReplayModel['trips'][number]>();
  waypoints.forEach((w, i) => {
    const trip = w.trip_index ?? 0;
    const t = stopTimes[i];
    const at: LatLngTuple = [w.lat, w.lng];
    const cur = tripMap.get(trip);
    if (!cur) tripMap.set(trip, { trip, t0: t, t1: t, at0: at, at1: at });
    else if (t >= cur.t1) Object.assign(cur, { t1: t, at1: at });
    if (w.path_from_prev && w.path_from_prev.length >= 2) {
      // previous stop of the same trip
      let j = i - 1;
      while (j >= 0 && (waypoints[j].trip_index ?? 0) !== trip) j--;
      if (j >= 0) segments.push({ trip, t0: stopTimes[j], t1: t, path: w.path_from_prev, cum: cumulativeM(w.path_from_prev) });
    }
  });

  const times = [...new Set(stopTimes)].sort((a, b) => a - b);
  const start = times[0] ?? 0;
  const end = times[times.length - 1] ?? 0;
  const moving = (a: number, b: number) => segments.some((s) => s.t0 <= a && s.t1 >= b);
  const pairs = times.slice(1).map((t1, k) => ({ t0: times[k], t1, moving: moving(times[k], t1) }));
  const movingTotal = pairs.reduce((acc, p) => acc + (p.moving ? p.t1 - p.t0 : 0), 0);
  const gaps = pairs.filter((p) => !p.moving).length;
  const budget = Math.max(targetMs - gaps * gapMs, targetMs * 0.5);

  const intervals: Interval[] = [];
  let r = 0;
  for (const p of pairs) {
    const len = p.moving ? Math.max(350, movingTotal > 0 ? ((p.t1 - p.t0) / movingTotal) * budget : 0) : gapMs;
    intervals.push({ r0: r, r1: r + len, t0: p.t0, t1: p.t1 });
    r += len;
  }
  return { start, end, duration: Math.max(r, 1), segments, trips: [...tripMap.values()], intervals, stopTimes };
}

/** Real epoch-ms time at replay clock `ms`. */
export function realTimeAt(model: ReplayModel, ms: number): number {
  if (model.intervals.length === 0) return model.start;
  if (ms <= 0) return model.start;
  for (const iv of model.intervals) {
    if (ms <= iv.r1) return iv.t0 + ((ms - iv.r0) / (iv.r1 - iv.r0 || 1)) * (iv.t1 - iv.t0);
  }
  return model.end;
}

/** Replay clock (ms) at which real time `t` is reached. */
export function replayMsAt(model: ReplayModel, t: number): number {
  for (const iv of model.intervals) {
    if (t <= iv.t1) return iv.r0 + ((t - iv.t0) / (iv.t1 - iv.t0 || 1)) * (iv.r1 - iv.r0);
  }
  return model.duration;
}

/** Positions of every trip that is under way (or waiting at a stop) at real time `t`. */
export function positionsAt(model: ReplayModel, t: number): ReplayPosition[] {
  const out: ReplayPosition[] = [];
  for (const trip of model.trips) {
    if (t < trip.t0 || t > trip.t1) continue;
    const seg = model.segments.find((s) => s.trip === trip.trip && s.t0 <= t && t <= s.t1);
    if (seg) {
      const f = seg.t1 > seg.t0 ? (t - seg.t0) / (seg.t1 - seg.t0) : 1;
      const { at, bearing } = pointAlong(seg.path, seg.cum, f * seg.cum[seg.cum.length - 1]);
      out.push({ trip: trip.trip, at, bearing, moving: true });
    } else {
      // Parked at the most recent stop of this trip.
      const before = model.segments.filter((s) => s.trip === trip.trip && s.t1 <= t).sort((a, b) => b.t1 - a.t1)[0];
      const at = before ? before.path[before.path.length - 1] : trip.at0;
      out.push({ trip: trip.trip, at, bearing: 0, moving: false });
    }
  }
  return out;
}

/** Index of the last waypoint reached by real time `t` (-1 before the first). */
export function stopIndexAt(model: ReplayModel, t: number): number {
  let idx = -1;
  model.stopTimes.forEach((st, i) => {
    if (st <= t) idx = i;
  });
  return idx;
}
