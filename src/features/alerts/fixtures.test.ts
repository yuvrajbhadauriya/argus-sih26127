// The mock alert feed must stay in step with the simulated network it mirrors.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mockAlerts, mockAnomalyAlerts, mockAlertFeed, mockBlacklistEntries } from '@/mocks/fixtures/mockAlerts';

const read = (f: string) => JSON.parse(readFileSync(resolve(process.cwd(), 'public/sim', f), 'utf8'));
const SUMMARY = read('summary.json');
const JOURNEYS = read('journeys.json') as { journeys: { id: string; plate_text: string; sightings: [string, string][] }[] };

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
