// Ordering helpers for alerts shown on the Live Map.
import type { AlertPriority, AlertRecord } from '@/types';

const RANK: Record<AlertPriority, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Unacknowledged alerts, most severe first, newest first within a severity. */
export function topOpenAlerts(alerts: AlertRecord[], limit = 8): AlertRecord[] {
  return alerts
    .filter((a) => !a.acknowledged)
    .sort((a, b) => RANK[a.priority] - RANK[b.priority] || new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit);
}

export interface AlertHotspot {
  key: string;
  lat: number;
  lng: number;
  count: number;
  cameraName: string;
  worst: AlertPriority;
}

/** Open alerts grouped by camera (location) for the hotspot layer. */
export function alertHotspots(alerts: AlertRecord[]): AlertHotspot[] {
  const map = new Map<string, AlertHotspot>();
  for (const a of alerts) {
    if (a.acknowledged) continue;
    const key = a.camera_id || `${a.lat},${a.lng}`;
    const h = map.get(key);
    if (h) {
      h.count++;
      if (RANK[a.priority] < RANK[h.worst]) h.worst = a.priority;
    } else {
      map.set(key, { key, lat: a.lat, lng: a.lng, count: 1, cameraName: a.camera_name, worst: a.priority });
    }
  }
  return [...map.values()];
}
