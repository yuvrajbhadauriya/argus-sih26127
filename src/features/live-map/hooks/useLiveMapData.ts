// Live Map side data: simulation summary (KPIs) and alerts. Each source has
// its own loading/error so one failure never blanks the command view.
import { useCallback, useEffect, useState } from 'react';
import type { AlertRecord } from '@/types';
import { fetchAlerts } from '@/features/alerts/api';
import { subscribeAlertEvents } from '@/features/alerts/live';
import { subscribeReplay } from '@/features/replay/clock';
import { fetchSimSummary, type SimSummary } from '../api';

interface Source<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

function useSource<T>(load: () => Promise<T>): Source<T> & { retry: () => void; refresh: () => void } {
  const [state, setState] = useState<Source<T>>({ data: null, loading: true, error: null });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let active = true;
    load()
      .then((data) => active && setState({ data, loading: false, error: null }))
      .catch((e: unknown) => active && setState({ data: null, loading: false, error: e instanceof Error ? e.message : 'Failed to load' }));
    return () => {
      active = false;
    };
  }, [load, nonce]);
  const retry = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: null }));
    setNonce((n) => n + 1);
  }, []);
  /** Re-load in the background (keeps showing the current data). */
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, retry, refresh };
}

export function useLiveMapData() {
  const summary = useSource<SimSummary>(fetchSimSummary);
  const alerts = useSource<AlertRecord[]>(fetchAlerts);
  const { refresh } = alerts;
  // Live alert events (Realtime / replay) and replay scrubbing change the set.
  useEffect(() => {
    const offEvents = subscribeAlertEvents(refresh);
    const offReplay = subscribeReplay((prev, next, change) => {
      if (change !== 'tick' && (prev.active !== next.active || prev.clock !== next.clock)) refresh();
    });
    return () => {
      offEvents();
      offReplay();
    };
  }, [refresh]);
  return { summary, alerts };
}
