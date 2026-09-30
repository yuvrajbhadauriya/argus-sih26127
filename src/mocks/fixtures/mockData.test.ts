// Referential-integrity checks on the mock fallback dataset. The UI silently
// falls back to these whenever Supabase is unconfigured or a query fails, so
// they must be internally consistent.
import { describe, it, expect } from 'vitest';
import { mockCameras, getCameraStatusCounts, getUniqueZones } from './mockCameras';
import { mockAlerts, mockBlacklistEntries } from './mockAlerts';
import { mockDetections } from './mockDetections';
import { mockVehicles, mockTrajectories } from './mockTrajectories';

const cameraIds = new Set(mockCameras.map((c) => c.id));

describe('mockCameras + helpers', () => {
  it('has unique ids and codes with valid coordinates', () => {
    expect(cameraIds.size).toBe(mockCameras.length);
    expect(new Set(mockCameras.map((c) => c.code)).size).toBe(mockCameras.length);
    for (const c of mockCameras) {
      expect(c.lat).toBeGreaterThan(28);
      expect(c.lat).toBeLessThan(29);
      expect(c.lng).toBeGreaterThan(76);
      expect(c.lng).toBeLessThan(78);
    }
  });

  it('getCameraStatusCounts sums to total', () => {
    const counts = getCameraStatusCounts(mockCameras);
    expect(counts.online + counts.offline + counts.maintenance).toBe(counts.total);
    expect(getCameraStatusCounts([])).toEqual({ online: 0, offline: 0, maintenance: 0, total: 0 });
  });

  it('getUniqueZones is sorted and de-duplicated', () => {
    const zones = getUniqueZones(mockCameras);
    expect(zones).toEqual([...new Set(zones)].sort());
  });
});

describe('mockAlerts integrity', () => {
  const blIds = new Set(mockBlacklistEntries.map((b) => b.id));
  it('every alert references an existing camera and blacklist entry with matching plate', () => {
    for (const a of mockAlerts) {
      expect(cameraIds.has(a.camera_id)).toBe(true);
      expect(blIds.has(a.blacklist_entry_id)).toBe(true);
      const bl = mockBlacklistEntries.find((b) => b.id === a.blacklist_entry_id)!;
      expect(a.plate_text).toBe(bl.plate_text);
    }
  });

  it('alert ids are unique', () => {
    expect(new Set(mockAlerts.map((a) => a.id)).size).toBe(mockAlerts.length);
  });
});

describe('mockDetections integrity', () => {
  it('detections are keyed by an existing camera and self-consistent', () => {
    for (const [camId, dets] of Object.entries(mockDetections)) {
      expect(cameraIds.has(camId)).toBe(true);
      for (const d of dets) {
        expect(d.camera_id).toBe(camId);
        expect(d.plate_text_normalized).toBe(d.plate_text_raw.replace(/[\s-]/g, ''));
        expect(d.confidence_score).toBeGreaterThanOrEqual(0);
        expect(d.confidence_score).toBeLessThanOrEqual(1);
        // Boxes may extend past the 640x360 edge (vehicle leaving frame); canvas clips them.
        expect(d.bbox.x).toBeGreaterThanOrEqual(0);
        expect(d.bbox.y).toBeGreaterThanOrEqual(0);
        expect(d.bbox.width).toBeGreaterThan(0);
        expect(d.bbox.height).toBeGreaterThan(0);
      }
    }
  });
});

describe('mockTrajectories integrity', () => {
  it('waypoints are chronological and time gaps match timestamps', () => {
    for (const t of Object.values(mockTrajectories)) {
      expect(t.waypoints.length).toBeGreaterThan(0);
      expect(t.waypoints[0].time_since_previous_seconds).toBeNull();
      for (let i = 1; i < t.waypoints.length; i++) {
        const prev = Date.parse(t.waypoints[i - 1].timestamp);
        const cur = Date.parse(t.waypoints[i].timestamp);
        expect(cur).toBeGreaterThanOrEqual(prev);
        expect(t.waypoints[i].time_since_previous_seconds).toBe(Math.round((cur - prev) / 1000));
      }
      expect(t.camera_count).toBe(new Set(t.waypoints.map((w) => w.camera_id)).size);
    }
  });

  it('every trajectory plate is a known vehicle', () => {
    const plates = new Set(mockVehicles.map((v) => v.plate_text));
    for (const t of Object.values(mockTrajectories)) expect(plates.has(t.plate_text)).toBe(true);
  });
});
