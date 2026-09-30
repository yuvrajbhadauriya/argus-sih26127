// The mock alert feed must stay in step with the simulated network it mirrors.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mockAlerts, mockAnomalyAlerts, mockAlertFeed, mockBlacklistEntries } from '@/mocks/fixtures/mockAlerts';
import { mockLiveFeed } from '@/mocks/fixtures/mockLiveFeed';
import { mockDetections } from '@/mocks/fixtures/mockDetections';
import { mockAuditLogs } from '@/mocks/fixtures/mockAdmin';
import { mockCameras } from '@/mocks/fixtures/mockCameras';

const read = (f: string) => JSON.parse(readFileSync(resolve(process.cwd(), 'public/sim', f), 'utf8'));
const SUMMARY = read('summary.json');
const JOURNEYS = read('journeys.json') as {
  journeys: { id: string; plate_text: string; vehicle_type: string; plate_variant?: string; sightings: [string, string][] }[];
};
/** plate → cameras it is seen at in the simulation */
const SEEN = new Map<string, Set<string>>();
for (const j of JOURNEYS.journeys) {
  const set = SEEN.get(j.plate_text) ?? new Set<string>();
  j.sightings.forEach(([code]) => set.add(code));
  SEEN.set(j.plate_text, set);
}
const PLATE = /^([A-Z]{2} \d{2} [A-Z]{1,2} \d{4}|\d{2} BH \d{4} [A-Z]{1,2})$/;

describe('mock alert feed vs public/sim', () => {
  it('every watchlist hit is a real sighting of that plate', () => {
    const byId = new Map(JOURNEYS.journeys.map((j) => [j.id, j]));
    for (const a of mockAlerts) {
      const [, jid, k] = a.detection_event_id.match(/^sim-(J\d+)-(\d+)$/)!;
      const j = byId.get(jid)!;
      expect(j.plate_text).toBe(a.plate_text);
      const [code, ts] = j.sightings[Number(k)];
      expect(code).toBe(a.camera_code);
      expect(Date.parse(ts)).toBe(Date.parse(a.timestamp));
    }
  });

  it('covers every sighting of every curated watchlist plate', () => {
    for (const w of SUMMARY.demo.watchlist) {
      expect(mockAlerts.filter((a) => a.plate_text === w.plate_text)).toHaveLength(w.sightings);
      const bl = mockBlacklistEntries.find((b) => b.plate_text === w.plate_text)!;
      expect([bl.category, bl.priority]).toEqual([w.category, w.priority]);
    }
  });

  it('raises one alert per summary anomaly with its evidence', () => {
    expect(mockAnomalyAlerts.map((a) => [a.kind, a.plate_text])).toEqual(
      SUMMARY.demo.anomalies.map((a: { kind: string; plate_text: string }) => [a.kind, a.plate_text]),
    );
    SUMMARY.demo.anomalies.forEach((a: { evidence: { camera_code: string; timestamp: string }[] }, i: number) => {
      expect(mockAnomalyAlerts[i].evidence!.map((e) => [e.camera_code, Date.parse(e.timestamp)])).toEqual(
        a.evidence.map((e) => [e.camera_code, Date.parse(e.timestamp)]),
      );
    });
  });

  it('feed is newest first with unique ids, one pending hit per plate', () => {
    const t = mockAlertFeed.map((a) => Date.parse(a.timestamp));
    expect(t).toEqual([...t].sort((a, b) => b - a));
    expect(new Set(mockAlertFeed.map((a) => a.id)).size).toBe(mockAlertFeed.length);
    expect(mockAlerts.filter((a) => !a.acknowledged)).toHaveLength(SUMMARY.demo.watchlist.length);
    for (const a of mockAlerts.filter((x) => x.acknowledged)) {
      expect(Date.parse(a.acknowledged_at!)).toBeGreaterThan(Date.parse(a.timestamp));
    }
  });
});

describe('every visible mock plate belongs to the simulated Mumbai network', () => {
  it('live ANPR feed: each read is a real sighting of that plate at that camera', () => {
    expect(mockLiveFeed.length).toBeGreaterThan(4);
    for (const e of mockLiveFeed) {
      expect(SEEN.get(e.plate)?.has(e.cameraCode), `${e.plate} @ ${e.cameraCode}`).toBe(true);
      expect(mockCameras.find((c) => c.code === e.cameraCode)?.name).toBe(e.cameraName);
      const w = mockBlacklistEntries.find((b) => b.plate_text === e.plate && b.is_active);
      expect(e.watchlist).toBe(w ? w.priority : null);
    }
    expect(mockLiveFeed.some((e) => e.watchlist)).toBe(true);
  });

  it('detection log: plates are seen at the camera they are logged for', () => {
    const rows = Object.values(mockDetections).flat();
    expect(rows.length).toBeGreaterThanOrEqual(mockCameras.length * 2);
    for (const d of rows) {
      const code = mockCameras.find((c) => c.id === d.camera_id)!.code;
      expect(SEEN.get(d.plate_text_raw)?.has(code), `${d.plate_text_raw} @ ${code}`).toBe(true);
    }
  });

  it('plates use Indian HSRP formats and the watchlist/audit plates are simulated ones', () => {
    for (const b of mockBlacklistEntries) expect(b.plate_text).toMatch(PLATE);
    const curated = [...SUMMARY.demo.watchlist, ...SUMMARY.demo.anomalies].map((x: { plate_text: string }) => x.plate_text);
    for (const a of mockAuditLogs) {
      const plates = a.details.match(/\b[A-Z]{2} \d{2} [A-Z]{1,2} \d{4}\b/g) ?? [];
      for (const p of plates) expect(curated).toContain(p);
    }
    // Watchlist entries without sightings today are really absent from the simulation.
    for (const b of mockBlacklistEntries.slice(SUMMARY.demo.watchlist.length)) expect(SEEN.has(b.plate_text)).toBe(false);
  });
});

