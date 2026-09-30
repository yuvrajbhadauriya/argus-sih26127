import type { Trajectory } from '@/types';

/** Default (light-theme) palette; pass `useThemeTokens().series` for the active theme. */
export const TRIP_COLORS = ['#1F6FEB', '#0F8A7E', '#C4610F', '#8250DF', '#BF3989', '#6E7D00'] as const;
export const ANOMALY_COLOR = '#CF222E';

/**
 * Colour for each trip; the trip holding a cloned-plate hit is drawn in the
 * anomaly colour. `series` / `anomaly` come from the theme tokens.
 */
export function tripColors(
  t: Trajectory,
  series: readonly string[] = TRIP_COLORS,
  anomaly: string = ANOMALY_COLOR,
): (trip: number) => string {
  const flagged = new Set<number>();
  for (const a of t.anomalies ?? []) {
    if (a.kind === 'cloned_plate' && a.waypoint_indices?.length) {
      const wp = t.waypoints[a.waypoint_indices[a.waypoint_indices.length - 1]];
      if (wp) flagged.add(wp.trip_index ?? 0);
    }
  }
  return (trip: number) => (flagged.has(trip) ? anomaly : series[trip % series.length]);
}

/** Readable text colour (#0B0F14 or #FFFFFF) on a #RRGGBB background. */
export function textOn(hex: string): string {
  const p = parseInt(hex.replace('#', '').slice(0, 6), 16);
  if (!Number.isFinite(p)) return '#FFFFFF';
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin((p >> 16) & 255) + 0.7152 * lin((p >> 8) & 255) + 0.0722 * lin(p & 255);
  return L > 0.3 ? '#0B0F14' : '#FFFFFF';
}
