// ═══════════════════════════════════════════════════
// Network analytics — pure aggregation over simulated journeys
//
// Everything on the Analytics page is computed here from the journey log
// (public/sim/journeys.json) for one time window, so the window selector
// genuinely re-scopes every chart. Unit-tested in aggregate.test.ts.
// ═══════════════════════════════════════════════════

import type { SimJourney } from '@/features/vehicles/lib/trajectory';

// ── time windows ─────────────────────────────────

export type TimeWindowId = 'all' | 'am_peak' | 'midday' | 'pm_peak' | 'night';

export interface TimeWindow {
  id: TimeWindowId;
  label: string;
  /** IST hours included (0–23). */
  hours: number[];
}

const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);

export const TIME_WINDOWS: TimeWindow[] = [
  { id: 'all', label: 'Full day (00:00–24:00)', hours: range(0, 24) },
  { id: 'am_peak', label: 'Morning peak (08:00–11:00)', hours: range(8, 11) },
  { id: 'midday', label: 'Midday (11:00–16:00)', hours: range(11, 16) },
  { id: 'pm_peak', label: 'Evening peak (17:00–21:00)', hours: range(17, 21) },
  { id: 'night', label: 'Night (22:00–06:00)', hours: [22, 23, ...range(0, 6)] },
];

export const getWindow = (id: string): TimeWindow => TIME_WINDOWS.find((w) => w.id === id) ?? TIME_WINDOWS[0];

const IST_OFFSET_MS = 5.5 * 3600 * 1000;
/** IST hour (0–23) of an ISO timestamp, whatever offset it is written in. */
export function istHour(iso: string): number {
  const ms = Date.parse(iso);
  return Math.floor((((ms + IST_OFFSET_MS) / 3_600_000) % 24 + 24) % 24);
}

// ── input / output shapes ────────────────────────

export interface CameraMeta {
  code: string;
  name: string;
  zone: string;
  lat: number;
  lng: number;
}

export type CongestionLevel = 'high' | 'medium' | 'low';

export interface CameraLoad extends CameraMeta {
  sightings: number;
  /** Mean speed of hops arriving at this camera (km/h), null when none. */
  avgSpeed: number | null;
  arrivals: number;
  level: CongestionLevel;
  /** Volume share × slowness; higher = worse bottleneck. */
  bottleneckScore: number;
}

export interface ZoneStat {
  zone: string;
  sightings: number;
  avgSpeed: number | null;
  level: CongestionLevel;
  cameras: number;
}

export interface OdCell {
  count: number;
  /** Mean first-to-last sighting time for these journeys (s). */
  avgTimeS: number | null;
}

export interface OdMatrix {
  zones: string[];
  /** cells[origin][destination] */
  cells: OdCell[][];
  max: number;
}

export interface Flow {
  from: CameraMeta;
  to: CameraMeta;
  count: number;
  avgTimeS: number | null;
}

export interface Corridor {
  id: string;
  from: CameraMeta;
  to: CameraMeta;
  /** Hops in either direction between the two cameras. */
  trips: number;
  avgTimeS: number;
  avgSpeed: number;
  avgDistanceM: number;
  peakHour: number;
  peakCount: number;
}

export interface SpeedStats {
  n: number;
  mean: number;
  min: number;
  max: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  /** 5 km/h bins. */
  histogram: { from: number; to: number; count: number }[];
}

export interface NetworkAnalytics {
  window: TimeWindow;
  totals: {
    vehicles: number;
    journeys: number;
    sightings: number;
    multiCameraJourneys: number;
    multiCameraPct: number;
    meanHopSpeed: number | null;
    totalKm: number;
  };
  /** Sightings per IST hour for the whole day (the window is highlighted, not cut). */
  hourly: number[];
  /** Sightings per IST hour per zone, whole day. */
  hourlyByZone: { zone: string; values: number[] }[];
  cameras: CameraLoad[];
  zones: ZoneStat[];
  speed: SpeedStats | null;
  /** Zone-to-zone journeys (origin = first sighting, destination = last). */
  od: OdMatrix;
  topFlows: Flow[];
  corridors: Corridor[];
}

// ── helpers ──────────────────────────────────────

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function speedStats(speeds: number[]): SpeedStats | null {
  if (speeds.length === 0) return null;
  const s = [...speeds].sort((a, b) => a - b);
  const top = Math.ceil(s[s.length - 1] / 5) * 5 || 5;
  const histogram = range(0, top / 5).map((i) => ({ from: i * 5, to: i * 5 + 5, count: 0 }));
  for (const v of s) histogram[Math.min(histogram.length - 1, Math.floor(v / 5))].count++;
  return {
    n: s.length,
    mean: round1(mean(s)!),
    min: s[0],
    max: s[s.length - 1],
    p10: round1(quantile(s, 0.1)),
    p25: round1(quantile(s, 0.25)),
    p50: round1(quantile(s, 0.5)),
    p75: round1(quantile(s, 0.75)),
    p90: round1(quantile(s, 0.9)),
    histogram,
  };
}

/** Level from mean speed relative to the network mean (slower = more congested). */
export function congestionLevel(avgSpeed: number | null, networkMean: number | null): CongestionLevel {
  if (avgSpeed == null || networkMean == null) return 'low';
  if (avgSpeed < networkMean * 0.9) return 'high';
  if (avgSpeed < networkMean * 1.05) return 'medium';
  return 'low';
}

// ── main aggregation ─────────────────────────────

/**
 * Aggregate journeys for one time window. A sighting (and the hop arriving at
 * it) belongs to the window by its IST hour; a journey belongs to it by its
 * first sighting. `hourly` always spans the full day so the chart can show the
 * window in context.
 */
export function aggregateNetwork(journeys: SimJourney[], cameraList: CameraMeta[], windowId: TimeWindowId | string = 'all'): NetworkAnalytics {
  const window = getWindow(windowId);
  const inWin = new Set(window.hours);
  const cams = new Map(cameraList.map((c) => [c.code, c]));
  const zoneOf = (code: string) => cams.get(code)?.zone ?? 'Unknown';

  const hourly = new Array<number>(24).fill(0);
  const hourlyZone = new Map<string, number[]>();
  const camSightings = new Map<string, number>();
  const camSpeeds = new Map<string, number[]>();
  const speeds: number[] = [];
  const plates = new Set<string>();
  const od = new Map<string, { count: number; times: number[] }>();
  const flows = new Map<string, { count: number; times: number[] }>();
  const hops = new Map<string, { times: number[]; speeds: number[]; dists: number[]; hours: number[] }>();
  let journeysN = 0;
  let multi = 0;
  let sightingsN = 0;
  let totalM = 0;

  for (const j of journeys) {
    const s = j.sightings;
    if (s.length === 0) continue;
    for (const [code, ts] of s) {
      const h = istHour(ts);
      hourly[h]++;
      const z = zoneOf(code);
      if (!hourlyZone.has(z)) hourlyZone.set(z, new Array<number>(24).fill(0));
      hourlyZone.get(z)![h]++;
    }

    const startInWin = inWin.has(istHour(s[0][1]));
    if (startInWin) {
      journeysN++;
      plates.add(j.plate_text);
      const distinct = new Set(s.map((x) => x[0])).size;
      if (distinct >= 2) {
        multi++;
        const first = s[0];
        const last = s[s.length - 1];
        const dt = (Date.parse(last[1]) - Date.parse(first[1])) / 1000;
        const okey = `${zoneOf(first[0])}|${zoneOf(last[0])}`;
        const o = od.get(okey) ?? { count: 0, times: [] };
        o.count++;
        o.times.push(dt);
        od.set(okey, o);
        if (first[0] !== last[0]) {
          const fkey = `${first[0]}>${last[0]}`;
          const f = flows.get(fkey) ?? { count: 0, times: [] };
          f.count++;
          f.times.push(dt);
          flows.set(fkey, f);
        }
      }
    }

    s.forEach(([code, ts, , kmph, dist], i) => {
      const h = istHour(ts);
      if (!inWin.has(h)) return;
      sightingsN++;
      camSightings.set(code, (camSightings.get(code) ?? 0) + 1);
      if (i === 0 || kmph == null) return;
      speeds.push(kmph);
      totalM += dist ?? 0;
      const cs = camSpeeds.get(code);
      if (cs) cs.push(kmph);
      else camSpeeds.set(code, [kmph]);
      const prev = s[i - 1][0];
      if (prev === code) return;
      const key = [prev, code].sort().join('|');
      const hop = hops.get(key) ?? { times: [], speeds: [], dists: [], hours: [] };
      hop.times.push((Date.parse(ts) - Date.parse(s[i - 1][1])) / 1000);
      hop.speeds.push(kmph);
      hop.dists.push(dist ?? 0);
      hop.hours.push(h);
      hops.set(key, hop);
    });
  }

  const networkMean = mean(speeds);
  const maxCamSightings = Math.max(1, ...camSightings.values());

  const cameras: CameraLoad[] = cameraList
    .map((c) => {
      const sp = camSpeeds.get(c.code) ?? [];
      const avg = mean(sp);
      const sightings = camSightings.get(c.code) ?? 0;
      const slowness = avg && networkMean ? networkMean / avg : 1;
      return {
        ...c,
        sightings,
        arrivals: sp.length,
        avgSpeed: avg == null ? null : round1(avg),
        level: congestionLevel(avg, networkMean),
        bottleneckScore: Math.round((sightings / maxCamSightings) * slowness * 100),
      };
    })
    .sort((a, b) => b.sightings - a.sightings);

  const zoneNames = [...new Set(cameraList.map((c) => c.zone))].sort();
  const zones: ZoneStat[] = zoneNames
    .map((zone) => {
      const zc = cameraList.filter((c) => c.zone === zone);
      const sp = zc.flatMap((c) => camSpeeds.get(c.code) ?? []);
      const avg = mean(sp);
      return {
        zone,
        cameras: zc.length,
        sightings: zc.reduce((n, c) => n + (camSightings.get(c.code) ?? 0), 0),
        avgSpeed: avg == null ? null : round1(avg),
        level: congestionLevel(avg, networkMean),
      };
    })
    .sort((a, b) => b.sightings - a.sightings);

  const odCells = zoneNames.map((o) =>
    zoneNames.map((d) => {
      const v = od.get(`${o}|${d}`);
      return { count: v?.count ?? 0, avgTimeS: v ? Math.round(mean(v.times)!) : null };
    }),
  );

  const meta = (code: string): CameraMeta => cams.get(code) ?? { code, name: code, zone: 'Unknown', lat: 0, lng: 0 };

  const topFlows: Flow[] = [...flows.entries()]
    .map(([k, v]) => {
      const [a, b] = k.split('>');
      return { from: meta(a), to: meta(b), count: v.count, avgTimeS: Math.round(mean(v.times)!) };
    })
    .sort((a, b) => b.count - a.count || a.from.code.localeCompare(b.from.code))
    .slice(0, 12);

  const corridors: Corridor[] = [...hops.entries()]
    .map(([k, v]) => {
      const [a, b] = k.split('|');
      const byHour = new Array<number>(24).fill(0);
      v.hours.forEach((h) => byHour[h]++);
      const peakCount = Math.max(...byHour);
      return {
        id: k,
        from: meta(a),
        to: meta(b),
        trips: v.times.length,
        avgTimeS: Math.round(mean(v.times)!),
        avgSpeed: round1(mean(v.speeds)!),
        avgDistanceM: Math.round(mean(v.dists)!),
        peakHour: byHour.indexOf(peakCount),
        peakCount,
      };
    })
    .sort((a, b) => b.trips - a.trips || a.id.localeCompare(b.id));

  return {
    window,
    totals: {
      vehicles: plates.size,
      journeys: journeysN,
      sightings: sightingsN,
      multiCameraJourneys: multi,
      multiCameraPct: journeysN ? Math.round((multi / journeysN) * 1000) / 10 : 0,
      meanHopSpeed: networkMean == null ? null : round1(networkMean),
      totalKm: Math.round(totalM / 100) / 10,
    },
    hourly,
    hourlyByZone: zoneNames.map((zone) => ({ zone, values: hourlyZone.get(zone) ?? new Array<number>(24).fill(0) })),
    cameras,
    zones,
    speed: speedStats(speeds),
    od: { zones: zoneNames, cells: odCells, max: Math.max(0, ...odCells.flat().map((c) => c.count)) },
    topFlows,
    corridors,
  };
}
