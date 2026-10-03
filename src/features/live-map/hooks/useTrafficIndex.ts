// Loads the per-frame overlay rows of each camera (detections_<CAM>.json) once the Traffic layer is on, and
// turns them into traffic indices. Failures are quiet: a camera without a file simply has no glow.
import { useEffect, useMemo, useState } from 'react';
import { DETECTION_FILE_FETCH, loadDetectionsManifest } from '@/features/detections/api';
import { buildTrafficIndex, type TrafficIndex } from '../lib/trafficDensity';

const rowsCache = new Map<string, Promise<unknown>>();

function loadRows(code: string): Promise<unknown> {
  let p = rowsCache.get(code);
  if (!p) {
    p = fetch(`/detections/detections_${code}.json`, DETECTION_FILE_FETCH)
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null);
    rowsCache.set(code, p);
  }
  return p;
}

/** Test hook. */
export function resetTrafficRows() {
  rowsCache.clear();
}

const EMPTY: ReadonlyMap<string, TrafficIndex> = new Map();

/**
 * @param enabled   load only when the Traffic layer is on
 * @param durations clip length (s) per camera code from the events files (the live clock's loop length)
 */
export function useTrafficIndex(enabled: boolean, durations: ReadonlyMap<string, number>): ReadonlyMap<string, TrafficIndex> {
  const [rows, setRows] = useState<ReadonlyMap<string, unknown>>(new Map());
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void loadDetectionsManifest()
      .then((codes) => Promise.all([...codes].map(async (c) => [c, await loadRows(c)] as const)))
      .then((all) => alive && setRows(new Map(all.filter(([, r]) => r != null))))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [enabled]);
  return useMemo(() => {
    if (!enabled) return EMPTY;
    const out = new Map<string, TrafficIndex>();
    for (const [code, r] of rows) {
      const idx = buildTrafficIndex(r, durations.get(code));
      if (idx) out.set(code, idx);
    }
    return out;
  }, [enabled, rows, durations]);
}
