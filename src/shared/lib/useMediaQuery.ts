// Subscribe to a CSS media query. Returns `fallback` where matchMedia is
// unavailable (jsdom, SSR), so components render their desktop layout there.

import { useCallback, useSyncExternalStore } from 'react';

export const PHONE_QUERY = '(max-width: 767px)';

function getMql(query: string): MediaQueryList | null {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null;
  } catch {
    return null;
  }
}

export function useMediaQuery(query: string, fallback = false): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      const mql = getMql(query);
      mql?.addEventListener?.('change', cb);
      return () => mql?.removeEventListener?.('change', cb);
    },
    [query],
  );
  const get = () => getMql(query)?.matches ?? fallback;
  return useSyncExternalStore(subscribe, get, () => fallback);
}

/** True below 768px (phones, portrait first). */
export function useIsPhone(): boolean {
  return useMediaQuery(PHONE_QUERY);
}
