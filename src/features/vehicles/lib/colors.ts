import type { Trajectory } from '@/types';

export const TRIP_COLORS = ['#38bdf8', '#34d399', '#a78bfa', '#f59e0b', '#22d3ee', '#f472b6'];
export const ANOMALY_COLOR = '#f43f5e';

/** Colour for each trip; the trip holding a cloned-plate hit is drawn red. */
export function tripColors(t: Trajectory): (trip: number) => string {
  const flagged = new Set<number>();
  for (const a of t.anomalies ?? []) {
    if (a.kind === 'cloned_plate' && a.waypoint_indices?.length) {
      const wp = t.waypoints[a.waypoint_indices[a.waypoint_indices.length - 1]];
      if (wp) flagged.add(wp.trip_index ?? 0);
    }
  }
  return (trip: number) => (flagged.has(trip) ? ANOMALY_COLOR : TRIP_COLORS[trip % TRIP_COLORS.length]);
}
