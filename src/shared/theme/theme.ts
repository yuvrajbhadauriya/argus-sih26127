// ═══════════════════════════════════════════════════
// Theme store — light / dark / system, no React Provider needed.
// External store (useSyncExternalStore) so any component, and tests that
// render without wrappers, can read the theme. Every localStorage and
// matchMedia access is guarded (jsdom has no matchMedia; storage may throw
// in private mode).
// ═══════════════════════════════════════════════════

import { useCallback, useSyncExternalStore } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'nero.theme';
export const THEME_COLOR: Record<ResolvedTheme, string> = { light: '#F4F6F9', dark: '#0B0F14' };

const DARK_QUERY = '(prefers-color-scheme: dark)';
const listeners = new Set<() => void>();

function isPreference(v: unknown): v is ThemePreference {
  return v === 'light' || v === 'dark' || v === 'system';
}

/** First visit (nothing stored) opens in the light theme; 'dark' and 'system' are explicit choices. */
function readStored(): ThemePreference {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(THEME_STORAGE_KEY) : null;
    return isPreference(v) ? v : 'light';
  } catch {
    return 'light';
  }
}

let preference: ThemePreference = readStored();

function getMediaQuery(): MediaQueryList | null {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
    return window.matchMedia(DARK_QUERY) ?? null;
  } catch {
    return null;
  }
}

export function systemPrefersDark(): boolean {
  return !!getMediaQuery()?.matches;
}

function resolve(p: ThemePreference): ResolvedTheme {
  if (p === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return p;
}

/** Write the resolved theme to <html data-theme>, color-scheme and meta theme-color. */
function apply(): void {
  if (typeof document === 'undefined') return;
  const resolved = resolve(preference);
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  root.style.colorScheme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLOR[resolved]);
}

function notify(): void {
  listeners.forEach((l) => l());
}

export function getPreference(): ThemePreference {
  return preference;
}

export function getResolvedTheme(): ResolvedTheme {
  if (typeof document !== 'undefined') {
    const t = document.documentElement.dataset.theme;
    if (t === 'light' || t === 'dark') return t;
  }
  return resolve(preference);
}

export function setPreference(p: ThemePreference): void {
  preference = p;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, p);
  } catch {
    /* storage unavailable — keep in-memory preference */
  }
  apply();
  notify();
}

/** Flip between light and dark (leaves 'system' mode). */
export function toggleTheme(): void {
  setPreference(getResolvedTheme() === 'dark' ? 'light' : 'dark');
}

function onSystemChange(): void {
  if (preference !== 'system') return;
  apply();
  notify();
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  let mq: MediaQueryList | null = null;
  if (listeners.size === 1) {
    mq = getMediaQuery();
    try {
      mq?.addEventListener?.('change', onSystemChange);
    } catch {
      mq = null;
    }
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) {
      try {
        getMediaQuery()?.removeEventListener?.('change', onSystemChange);
      } catch {
        /* ignore */
      }
    }
  };
}

/** Re-read storage (tests). */
export function __resetThemeForTests(): void {
  preference = readStored();
  apply();
  notify();
}

// Keep <html> in sync on module load (the inline index.html script already
// did this before paint; this covers tests and pages without that script).
apply();

const getServerSnapshot = (): ResolvedTheme => 'light';

export function useTheme(): {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (p: ThemePreference) => void;
  toggle: () => void;
} {
  const pref = useSyncExternalStore(subscribe, getPreference, () => 'light' as ThemePreference);
  const resolved = useSyncExternalStore(subscribe, getResolvedTheme, getServerSnapshot);
  const set = useCallback((p: ThemePreference) => setPreference(p), []);
  return { preference: pref, resolved, setPreference: set, toggle: toggleTheme };
}
