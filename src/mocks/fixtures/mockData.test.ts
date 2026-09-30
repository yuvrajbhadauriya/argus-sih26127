// Referential-integrity checks on the demo fixtures. They back the
// simulated/demo data source (never a silent fallback for a failing live
// database), so they must be internally consistent.
import { describe, it, expect } from 'vitest';
import { mockCameras } from './mockCameras';
import { mockAlerts, mockBlacklistEntries } from './mockAlerts';
import { mockDetections } from './mockDetections';

const cameraIds = new Set(mockCameras.map((c) => c.id));

describe('mockCameras + helpers', () => {
  it('has unique ids and codes with valid coordinates', () => {
    expect(cameraIds.size).toBe(mockCameras.length);
    expect(new Set(mockCameras.map((c) => c.code)).size).toBe(mockCameras.length);
    for (const c of mockCameras) {
      expect(c.lat).toBeGreaterThan(18.89);
      expect(c.lat).toBeLessThan(19.28);
      expect(c.lng).toBeGreaterThan(72.77);
      expect(c.lng).toBeLessThan(72.99);
      expect(c.road, c.code).toBeTruthy();
      expect(['Northbound', 'Southbound', 'Eastbound', 'Westbound']).toContain(c.direction);
    }
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
