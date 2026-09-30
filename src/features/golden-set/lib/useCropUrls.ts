// Signed URLs for a set of golden-set crops (one batched request per render set).

import { useCallback, useMemo } from 'react';
import { objectPath, type GoldenItem, type GoldenResults } from './results';
import { signedUrlCache, useSignedUrls } from './signedUrls';

export interface CropUrls {
  /** string = signed URL, null = unavailable (show placeholder), undefined = loading. */
  url: (it: GoldenItem) => string | null | undefined;
  /** Call when an <img> fails: placeholder now, re-signed later. */
  broken: (it: GoldenItem) => void;
}

export function useCropUrls(r: GoldenResults, items: GoldenItem[]): CropUrls {
  const cache = signedUrlCache(r.bucket);
  const paths = useMemo(() => items.map((it) => objectPath(r, it)), [items, r]);
  const lookup = useSignedUrls(cache, paths);
  const url = useCallback((it: GoldenItem) => lookup(objectPath(r, it)), [lookup, r]);
  const broken = useCallback((it: GoldenItem) => cache.markBroken(objectPath(r, it)), [cache, r]);
  return { url, broken };
}
