// Active watchlist plates as plateKey()s (shared, fetched once per session;
// a failure just means nothing is highlighted).
import { useEffect, useState } from 'react';
import { fetchBlacklistEntries } from '@/features/alerts/api';
import type { AlertPriority } from '@/types';
import { plateKey } from '../lib/log';

export type WatchlistIndex = ReadonlyMap<string, AlertPriority>;

let cache: Promise<WatchlistIndex> | null = null;

export function loadWatchlistIndex(): Promise<WatchlistIndex> {
  cache ??= fetchBlacklistEntries()
    .then((list) => new Map(list.filter((b) => b.is_active).map((b) => [plateKey(b.plate_text), b.priority] as const)))
    .catch(() => {
      cache = null;
      return new Map<string, AlertPriority>();
    });
  return cache;
}

/** Test hook. */
export function resetWatchlistIndex() {
  cache = null;
}

const EMPTY: WatchlistIndex = new Map();

export function useWatchlistIndex(): WatchlistIndex {
  const [index, setIndex] = useState<WatchlistIndex>(EMPTY);
  useEffect(() => {
    let active = true;
    loadWatchlistIndex().then((m) => active && setIndex(m));
    return () => {
      active = false;
    };
  }, []);
  return index;
}

/** Just the keys (for the overlay). Stable identity per loaded index. */
const keyCache = new WeakMap<WatchlistIndex, ReadonlySet<string>>();
export function useWatchlistKeys(): ReadonlySet<string> {
  const index = useWatchlistIndex();
  let keys = keyCache.get(index);
  if (!keys) {
    keys = new Set(index.keys());
    keyCache.set(index, keys);
  }
  return keys;
}
