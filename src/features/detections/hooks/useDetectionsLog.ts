// ═══════════════════════════════════════════════════
// useDetectionsLog — ANPR event log across all cameras + the set of
// watchlisted plates (for row highlighting).
//
// Rows are the real model output: one row per vehicle whose plate passed the
// good-read rule (isDisplayableRead: OCR confidence ≥ DISPLAY_READ_MIN_CONFIDENCE
// and a valid Indian plate grammar), from /detections/events_<code>.json (see
// features/detections/api.ts). The Supabase `detections` table mirrors the same
// run frame by frame; it is not used here so the log stays one row per vehicle.
// ═══════════════════════════════════════════════════

import { useCallback, useEffect, useState } from 'react';
import type { Detection } from '@/types';
import { mockCameras } from '@/mocks/fixtures/mockCameras';
import { fetchBlacklistEntries } from '@/features/alerts/api';
import { fetchAllCameraEvents, isDisplayableRead, type CameraEvents } from '../api';
import { plateKey } from '../lib/log';

export interface DetectionsLog {
  rows: Detection[];
  /** Vehicles the model detected on the published clips (read or not). */
  vehiclesDetected: number;
}

const CAMERA_ID_BY_CODE = new Map(mockCameras.map((c) => [c.code, c.id]));

/** Published per-vehicle events → log rows (displayable reads only). */
export function eventsToLogRows(all: CameraEvents[]): Detection[] {
  const rows: Detection[] = [];
  for (const cam of all) {
    const cameraId = CAMERA_ID_BY_CODE.get(cam.camera_code) ?? cam.camera_code;
    for (const e of cam.events) {
      if (!isDisplayableRead(e)) continue;
      rows.push({
        event_id: `${cam.camera_code}-${e.tracked_vehicle_id}`,
        camera_id: cameraId,
        tracked_vehicle_id: e.tracked_vehicle_id,
        plate_text_raw: e.plate_text!,
        plate_text_normalized: plateKey(e.plate_text!),
        confidence_score: e.plate_confidence ?? 0,
        vehicle_type: e.vehicle_type,
        timestamp: e.time_sec,
        frame_timestamp_sec: e.time_sec,
        bbox: e.bbox,
      });
    }
  }
  return rows;
}

async function loadLog(): Promise<DetectionsLog> {
  const events = await fetchAllCameraEvents();
  return {
    rows: eventsToLogRows(events),
    vehiclesDetected: events.reduce((n, c) => n + c.events.length, 0),
  };
}

export function useDetectionsLog() {
  const [log, setLog] = useState<DetectionsLog>({ rows: [], vehiclesDetected: 0 });
  const [watchlist, setWatchlist] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let active = true;
    loadLog()
      .then((r) => {
        if (!active) return;
        setLog(r);
        setError(null);
      })
      .catch((e: unknown) => active && setError(e instanceof Error ? e.message : 'Failed to load detections'))
      .finally(() => active && setLoading(false));
    // Watchlist is decoration only: a failure must not blank the log.
    fetchBlacklistEntries()
      .then((list) => active && setWatchlist(new Set(list.filter((b) => b.is_active).map((b) => plateKey(b.plate_text)))))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [nonce]);

  const refetch = useCallback(() => {
    setLoading(true);
    setNonce((n) => n + 1);
  }, []);

  return { rows: log.rows, vehiclesDetected: log.vehiclesDetected, watchlist, loading, error, refetch };
}
