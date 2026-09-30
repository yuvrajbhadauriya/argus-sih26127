// ═══════════════════════════════════════════════════
// lazyPage — React.lazy for named page exports, with preload + a one-time
// reload if a chunk 404s (a new Vercel deploy replaced the hashed files
// while this tab still had the old index.html).
// ═══════════════════════════════════════════════════

import { lazy, type ComponentType } from 'react';

const RELOAD_KEY = 'nero:chunk-reload';

export interface LazyPage<P> {
  Component: ComponentType<P>;
  preload: () => Promise<unknown>;
}

export function lazyPage<M, K extends keyof M, P = object>(
  loader: () => Promise<M>,
  exportName: K,
): LazyPage<P> {
  let promise: Promise<M> | null = null;
  const load = () => {
    promise ??= loader().catch((err) => {
      promise = null;
      throw err;
    });
    return promise;
  };

  const Component = lazy(async () => {
    try {
      const mod = await load();
      try {
        sessionStorage.removeItem(RELOAD_KEY);
      } catch {
        /* storage unavailable */
      }
      return { default: mod[exportName] as unknown as ComponentType<P> };
    } catch (err) {
      let reloaded = true;
      try {
        reloaded = sessionStorage.getItem(RELOAD_KEY) === '1';
        if (!reloaded) sessionStorage.setItem(RELOAD_KEY, '1');
      } catch {
        /* storage unavailable → don't risk a reload loop */
      }
      if (!reloaded && typeof window !== 'undefined') {
        window.location.reload();
        return new Promise<never>(() => {});
      }
      throw err;
    }
  });

  return { Component, preload: () => load().catch(() => {}) };
}
