import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SimJourney } from '@/features/vehicles/lib/trajectory';
import { aggregateNetwork, istHour, quantile, speedStats, congestionLevel, TIME_WINDOWS, type CameraMeta } from './aggregate';
import { ANALYTICS_CAMERAS } from '../api';

const read = (f: string) => JSON.parse(readFileSync(resolve(process.cwd(), 'public/sim', f), 'utf8'));
const SUMMARY = read('summary.json');
const JOURNEYS: SimJourney[] = read('journeys.json').journeys;

const CAMS: CameraMeta[] = [
  { code: 'A', name: 'Alpha', zone: 'North', lat: 28.6, lng: 77.2 },
  { code: 'B', name: 'Bravo', zone: 'South', lat: 28.5, lng: 77.2 },
  { code: 'C', name: 'Charlie', zone: 'South', lat: 28.5, lng: 77.3 },
];
const j = (id: string, plate: string, s: SimJourney['sightings']): SimJourney => ({ id, plate_text: plate, vehicle_type: 'car', trip: 0, sightings: s });

describe('helpers', () => {
  it('istHour reads IST regardless of the written offset', () => {
    expect(istHour('2026-09-29T08:59:59+05:30')).toBe(8);
    expect(istHour('2026-09-29T03:30:00Z')).toBe(9);
    expect(istHour('2026-09-29T20:00:00Z')).toBe(1);
  });

  it('quantile interpolates and speedStats bins by 5 km/h', () => {
    expect(quantile([10, 20, 30, 40], 0.5)).toBe(25);
    const s = speedStats([12, 14, 22, 33])!;
    expect([s.min, s.max, s.mean, s.n]).toEqual([12, 33, 20.3, 4]);
    expect(s.histogram.reduce((n, b) => n + b.count, 0)).toBe(4);
    expect(s.histogram.find((b) => b.from === 10)!.count).toBe(2);
    expect(speedStats([])).toBeNull();
  });

  it('congestionLevel is relative to the network mean', () => {
    expect(congestionLevel(15, 20)).toBe('high');
    expect(congestionLevel(20, 20)).toBe('medium');
    expect(congestionLevel(30, 20)).toBe('low');
    expect(congestionLevel(null, 20)).toBe('low');
  });
});

describe('aggregateNetwork (synthetic)', () => {
  const data = [
    j('1', 'P1', [['A', '2026-09-29T08:00:00+05:30', 'N', null, null], ['B', '2026-09-29T08:20:00+05:30', 'S', 30, 10000]]),
    j('2', 'P2', [['B', '2026-09-29T18:00:00+05:30', 'N', null, null], ['A', '2026-09-29T18:40:00+05:30', 'N', 15, 10000], ['C', '2026-09-29T19:00:00+05:30', 'E', 20, 6000]]),
    j('3', 'P1', [['C', '2026-09-29T09:10:00+05:30', 'N', null, null]]),
  ];

  it('full day totals, OD and corridors', () => {
    const a = aggregateNetwork(data, CAMS, 'all');
    expect(a.totals).toMatchObject({ vehicles: 2, journeys: 3, sightings: 6, multiCameraJourneys: 2, totalKm: 26 });
    expect(a.totals.meanHopSpeed).toBeCloseTo(21.7, 1);
    expect(a.hourly.reduce((x, y) => x + y, 0)).toBe(6);
    expect(a.od.zones).toEqual(['North', 'South']);
    expect(a.od.cells[0][1].count).toBe(1); // North → South
    expect(a.od.cells[1][1].count).toBe(1); // South → South (B … C)
    const ab = a.corridors.find((c) => c.id === 'A|B')!;
    expect([ab.trips, ab.avgTimeS]).toEqual([2, 1800]);
    expect(a.topFlows.map((f) => `${f.from.code}>${f.to.code}`).sort()).toEqual(['A>B', 'B>C']);
  });

  it('a window re-scopes everything but the 24 h profile', () => {
    const am = aggregateNetwork(data, CAMS, 'am_peak');
    expect(am.totals).toMatchObject({ journeys: 2, sightings: 3, multiCameraJourneys: 1 });
    expect(am.cameras.find((c) => c.code === 'A')!.sightings).toBe(1);
    expect(am.corridors.map((c) => c.id)).toEqual(['A|B']);
    expect(am.hourly.reduce((x, y) => x + y, 0)).toBe(6);
    const pm = aggregateNetwork(data, CAMS, 'pm_peak');
    expect(pm.speed!.mean).toBe(17.5);
    expect(pm.cameras.find((c) => c.code === 'A')!.level).toBe('high');
  });
});

describe('aggregateNetwork on public/sim', () => {
  const all = aggregateNetwork(JOURNEYS, ANALYTICS_CAMERAS, 'all');

  it('matches the generator summary', () => {
    const st = SUMMARY.stats;
    expect(all.totals.journeys).toBe(st.journeys);
    expect(all.totals.sightings).toBe(st.sightings);
    expect(all.totals.vehicles).toBe(st.vehicles);
    expect(all.totals.multiCameraJourneys).toBe(st.multi_camera_journeys);
    expect(all.hourly).toEqual(st.sightings_per_hour);
    for (const c of all.cameras) expect(c.sightings).toBe(st.sightings_per_camera[c.code]);
    expect(all.speed!.mean).toBeCloseTo(st.hop_speed_kmph.mean, 0);
    expect(all.speed!.p50).toBeCloseTo(st.hop_speed_kmph.p50, 0);
    expect(Math.abs(all.totals.totalKm - st.total_distance_km) / st.total_distance_km).toBeLessThan(0.01);
  });

  it('every window yields a non-empty, smaller-or-equal slice', () => {
    for (const w of TIME_WINDOWS) {
      const a = aggregateNetwork(JOURNEYS, ANALYTICS_CAMERAS, w.id);
      expect(a.totals.sightings).toBeGreaterThan(0);
      expect(a.totals.sightings).toBeLessThanOrEqual(all.totals.sightings);
      expect(a.od.cells.flat().reduce((n, c) => n + c.count, 0)).toBe(a.totals.multiCameraJourneys);
    }
  });
});
