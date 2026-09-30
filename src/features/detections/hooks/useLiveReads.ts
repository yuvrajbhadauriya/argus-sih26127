// ═══════════════════════════════════════════════════
// useLiveReads — the real model reads for one camera (or the whole network)
// as they "happen" on the per-camera live clock; re-evaluated every second.
// ═══════════════════════════════════════════════════

import { useEffect, useMemo, useState } from 'react';
import { fetchAllCameraEvents, fetchCameraEvents, type CameraEvents } from '../api';
import { recentNetworkReads, type LiveRead, type LiveReadOptions } from '../lib/liveReads';

/** Seconds-resolution wall clock (one re-render per second while mounted). */
export function useNowSeconds(enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [enabled]);
  return now;
}

/** Events for one camera code, or for all cameras when `code` is null. */
export function useCameraEventsDocs(code: string | null): { docs: CameraEvents[]; loading: boolean } {
  const [state, setState] = useState<{ key: string; docs: CameraEvents[] } | null>(null);
  const key = code ?? '*';
  useEffect(() => {
    let active = true;
    const load = code ? fetchCameraEvents(code).then((d) => (d ? [d] : [])) : fetchAllCameraEvents();
    load
      .then((docs) => active && setState({ key, docs }))
      .catch(() => active && setState({ key, docs: [] }));
    return () => {
      active = false;
    };
  }, [code, key]);
  const current = state?.key === key ? state : null;
  return { docs: current?.docs ?? EMPTY, loading: current == null };
}

const EMPTY: CameraEvents[] = [];

export function useLiveReads(code: string | null, opts: LiveReadOptions = {}): { reads: LiveRead[]; docs: CameraEvents[]; loading: boolean; now: number } {
  const { docs, loading } = useCameraEventsDocs(code);
  const now = useNowSeconds(docs.length > 0);
  const { limit, maxAgeSec, maxLoops } = opts;
  const reads = useMemo(
    () => recentNetworkReads(docs, now, { limit, maxAgeSec, maxLoops }),
    [docs, now, limit, maxAgeSec, maxLoops],
  );
  return { reads, docs, loading, now };
}
