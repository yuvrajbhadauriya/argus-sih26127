// ═══════════════════════════════════════════════════
// Small geo + formatting helpers for trajectories (no Leaflet imports)
// ═══════════════════════════════════════════════════

export type LatLngTuple = [number, number];

const R = 6_371_008.8;
const toRad = (d: number) => (d * Math.PI) / 180;

export function haversineM(a: LatLngTuple, b: LatLngTuple): number {
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Initial bearing a → b in degrees clockwise from north, [0, 360). */
export function bearingDeg(a: LatLngTuple, b: LatLngTuple): number {
  const la1 = toRad(a[0]);
  const la2 = toRad(b[0]);
  const dl = toRad(b[1] - a[1]);
  const x = Math.sin(dl) * Math.cos(la2);
  const y = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dl);
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}

export const COMPASS_8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

export function compass8(bearing: number): (typeof COMPASS_8)[number] {
  return COMPASS_8[Math.floor((((bearing % 360) + 360) % 360 + 22.5) / 45) % 8];
}

export function headingToDegrees(heading?: string | null): number | null {
  if (!heading) return null;
  const i = (COMPASS_8 as readonly string[]).indexOf(heading.toUpperCase());
  return i < 0 ? null : i * 45;
}

const HEADING_NAMES: Record<string, string> = {
  N: 'Northbound', NE: 'North-east', E: 'Eastbound', SE: 'South-east',
  S: 'Southbound', SW: 'South-west', W: 'Westbound', NW: 'North-west',
};
export function headingLabel(heading?: string | null): string {
  return (heading && HEADING_NAMES[heading.toUpperCase()]) || '—';
}

/** Cumulative distances (m) along a polyline; result[0] = 0. */
export function cumulativeM(path: LatLngTuple[]): number[] {
  const out = [0];
  for (let i = 1; i < path.length; i++) out.push(out[i - 1] + haversineM(path[i - 1], path[i]));
  return out;
}

/** Point and local bearing at `dist` metres along `path` (clamped). */
export function pointAlong(path: LatLngTuple[], cum: number[], dist: number): { at: LatLngTuple; bearing: number } {
  if (path.length === 1) return { at: path[0], bearing: 0 };
  const total = cum[cum.length - 1];
  const d = Math.max(0, Math.min(total, dist));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const seg = cum[i] - cum[i - 1];
  const t = seg > 0 ? (d - cum[i - 1]) / seg : 0;
  const a = path[i - 1];
  const b = path[i];
  return { at: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], bearing: bearingDeg(a, b) };
}

/** Normalise a plate for matching: uppercase, alphanumerics only. */
export function normalizePlate(plate: string): string {
  return plate.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// ── formatting ─────────────────────────────────────

const IST_TIME = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const IST_HM = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
});
const IST_DATE = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
});

export const formatIstTime = (iso: string | number) => IST_TIME.format(new Date(iso));
export const formatIstHm = (iso: string | number) => IST_HM.format(new Date(iso));
export const formatIstDate = (iso: string | number) => IST_DATE.format(new Date(iso));

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m`;
  if (m > 0) return `${m} min`;
  return `${s}s`;
}

export function formatDistance(m: number | null | undefined): string {
  if (m == null || !Number.isFinite(m)) return '—';
  return m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`;
}

export function formatSpeed(kmph: number | null | undefined): string {
  if (kmph == null || !Number.isFinite(kmph)) return '—';
  return `${Math.round(kmph)} km/h`;
}
