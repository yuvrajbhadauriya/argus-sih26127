// ═══════════════════════════════════════════════════
// lazyPage — React.lazy for named page exports, with:
// - preload(): start (or reuse) the chunk download ahead of navigation
// - synchronous render once loaded: if the module is already in memory the
//   lazy factory returns a sync thenable, so React renders the page directly
//   instead of flashing the Suspense fallback (React throttles fallback →
//   content reveals by ~300 ms, so this matters for perceived speed)
// - a one-time reload if a chunk 404s (a new Vercel deploy replaced the
//   hashed files while this tab still had the old index.html)
// ═══════════════════════════════════════════════════

import { lazy, type ComponentType } from 'react';

const RELOAD_KEY = 'nero:chunk-reload';

export interface LazyPage<P> {
  Component: ComponentType<P>;
  preload: () => Promise<unknown>;
}

function clearReloadFlag() {
  try {
    sessionStorage.removeItem(RELOAD_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Reload once per session on a failed chunk import; returns false if we already tried. */
function reloadOnce(): boolean {
  let alreadyTried = true;
  try {
    alreadyTried = sessionStorage.getItem(RELOAD_KEY) === '1';
    if (!alreadyTried) sessionStorage.setItem(RELOAD_KEY, '1');
  } catch {
    /* storage unavailable → don't risk a reload loop */
  }
  if (alreadyTried || typeof window === 'undefined') return false;
  window.location.reload();
  return true;
}

export function lazyPage<M, K extends keyof M, P = object>(
  loader: () => Promise<M>,
  exportName: K,
): LazyPage<P> {
  let promise: Promise<M> | null = null;
  let loaded: ComponentType<P> | null = null;

  const load = () => {
    promise ??= loader().then(
      (mod) => {
        loaded = mod[exportName] as unknown as ComponentType<P>;
        return mod;
      },
      (err) => {
        promise = null;
        throw err;
      },
    );
    return promise;
  };

  const Component = lazy<ComponentType<P>>(() => {
    if (loaded) {
      const value = { default: loaded };
      // Sync thenable: React.lazy resolves it immediately (no suspend).
      return { then: (resolve: (v: typeof value) => void) => resolve(value) } as unknown as Promise<typeof value>;
    }
    return load().then(
      () => {
        clearReloadFlag();
        return { default: loaded! };
      },
      (err) => {
        if (reloadOnce()) return new Promise<never>(() => {});
        throw err;
      },
    );
  });

  return { Component, preload: () => load().catch(() => {}) };
}
