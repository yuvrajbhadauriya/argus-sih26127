// ═══════════════════════════════════════════════════
// useDetectionsLog — ANPR event log across all cameras + the set of
// watchlisted plates (for row highlighting).
// The log currently comes from the bundled mock dataset; the async shape
// (loading / error / refetch) is what a Supabase-backed source will need.
// ═══════════════════════════════════════════════════

import { useCallback, useEffect, useState } from 'react';
import type { Detection } from '@/types';
import { mockDetections } from '@/mocks/fixtures/mockDetections';
import { fetchBlacklistEntries } from '@/features/alerts/api';
import { plateKey } from '../lib/log';

async function loadLog(): Promise<Detection[]> {
  return Object.values(mockDetections).flat();
}

export function useDetectionsLog() {
  const [rows, setRows] = useState<Detection[]>([]);
  const [watchlist, setWatchlist] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let active = true;
    loadLog()
      .then((r) => {
        if (!active) return;
        setRows(r);
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

  return { rows, watchlist, loading, error, refetch };
}
