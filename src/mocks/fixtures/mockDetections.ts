// ═══════════════════════════════════════════════════
// Mock ANPR detection log — sample pipeline plate reads per camera, keyed by
// camera id. Plates, classes and cameras come from the simulated Mumbai
// network (simDemo.generated.ts), so every plate here can be traced on
// /vehicles. Frame times and boxes are illustrative (these rows are not drawn
// on the video; real overlays come from pipeline output, see detections/api.ts).
// ═══════════════════════════════════════════════════

import type { Detection, VehicleType } from '@/types';
import { mockCameras } from './mockCameras';
import { SIM_CAMERA_READS } from './simDemo.generated';

const pad = (n: number) => String(n).padStart(2, '0');
const frameTime = (sec: number) => `${pad(Math.floor(sec / 60))}:${pad(Math.floor(sec % 60))}.${String(Math.round((sec % 1) * 1000)).padStart(3, '0')}`;

export const mockDetections: Record<string, Detection[]> = {};
SIM_CAMERA_READS.forEach((r, i) => {
  const cam = mockCameras.find((c) => c.id === r.camera_id);
  const row: Detection = {
    event_id: `det-${r.camera_code}-${i + 1}`,
    camera_id: r.camera_id,
    plate_text_raw: r.plate_text,
    plate_text_normalized: r.plate_text.replace(/\s+/g, ''),
    confidence_score: r.confidence,
    vehicle_type: r.vehicle_type as VehicleType,
    timestamp: frameTime(r.frame_sec),
    frame_timestamp_sec: r.frame_sec,
    lat: cam?.lat,
    lng: cam?.lng,
    bbox: { x: 160 + (i % 3) * 260, y: 200 + (i % 2) * 120, width: 150, height: 96 },
  };
  (mockDetections[r.camera_id] ??= []).push(row);
});
