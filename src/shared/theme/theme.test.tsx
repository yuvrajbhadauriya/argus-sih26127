import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

type ThemeModule = typeof import('./theme');

function mockMatchMedia(dark: boolean) {
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const mql = {
    matches: dark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: (e: { matches: boolean }) => void) => listeners.delete(cb),
  };
  vi.stubGlobal('matchMedia', vi.fn(() => mql));
  return {
    set(next: boolean) {
      mql.matches = next;
      listeners.forEach((l) => l({ matches: next }));
    },
    listenerCount: () => listeners.size,
  };
}

async function load(): Promise<ThemeModule> {
  vi.resetModules();
  return import('./theme');
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.colorScheme = '';
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('theme store', () => {
  it('opens light even when the OS prefers dark; choosing System follows the OS', async () => {
    mockMatchMedia(true);
    const t = await load();
    expect(t.getPreference()).toBe('light');
    expect(t.getResolvedTheme()).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    t.setPreference('system');
    expect(t.getResolvedTheme()).toBe('dark');
  });

  it('defaults to the light theme and resolves light when matchMedia is missing (jsdom)', async () => {
    const t = await load();
    expect(t.getPreference()).toBe('light');
    expect(t.getResolvedTheme()).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('follows the OS dark preference in system mode and reacts to changes', async () => {
    localStorage.setItem('nero.theme', 'system');
    const mm = mockMatchMedia(true);
    const t = await load();
    expect(t.getResolvedTheme()).toBe('dark');
    const cb = vi.fn();
    const unsub = t.subscribe(cb);
    mm.set(false);
    expect(t.getResolvedTheme()).toBe('light');
    expect(cb).toHaveBeenCalled();
    unsub();
    expect(mm.listenerCount()).toBe(0);
  });

  it('ignores OS changes once an explicit preference is set', async () => {
    const mm = mockMatchMedia(false);
    const t = await load();
    t.setPreference('dark');
    const unsub = t.subscribe(() => {});
    mm.set(false);
    expect(t.getResolvedTheme()).toBe('dark');
    unsub();
  });

  it('persists the preference and applies data-theme, color-scheme and theme-color', async () => {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
    const t = await load();
    t.setPreference('dark');
    expect(localStorage.getItem(t.THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(meta.getAttribute('content')).toBe('#0B0F14');
    meta.remove();
  });

  it('reads a stored preference on load and ignores garbage values', async () => {
    localStorage.setItem('nero.theme', 'dark');
    let t = await load();
    expect(t.getPreference()).toBe('dark');
    localStorage.setItem('nero.theme', 'purple');
    t = await load();
    expect(t.getPreference()).toBe('light');
  });

  it('toggle flips between light and dark', async () => {
    const t = await load();
    t.toggleTheme();
    expect(t.getResolvedTheme()).toBe('dark');
    t.toggleTheme();
    expect(t.getResolvedTheme()).toBe('light');
    expect(t.getPreference()).toBe('light');
  });

  it('does not throw when localStorage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const t = await load();
    expect(t.getPreference()).toBe('light');
    expect(() => t.setPreference('dark')).not.toThrow();
    expect(t.getResolvedTheme()).toBe('dark');
  });

  it('does not throw when matchMedia throws', async () => {
    vi.stubGlobal('matchMedia', () => {
      throw new Error('boom');
    });
    const t = await load();
    expect(t.getResolvedTheme()).toBe('light');
    expect(() => t.subscribe(() => {})()).not.toThrow();
  });
});

describe('ThemeToggle', () => {
  it('icon variant toggles the theme and updates its label', async () => {
    localStorage.setItem('nero.theme', 'system');
    await load();
    const { ThemeToggle } = await import('@/shared/layout/ThemeToggle');
    render(<ThemeToggle />);
    const btn = screen.getByRole('button', { name: 'Switch to dark theme' });
    expect(btn).toHaveAttribute('title', expect.stringContaining('following system'));
    await userEvent.click(btn);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeInTheDocument();
  });

  it('segmented variant exposes a radiogroup with the current preference checked', async () => {
    const t = await load();
    const { ThemeToggle } = await import('@/shared/layout/ThemeToggle');
    render(<ThemeToggle variant="segmented" />);
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
    expect(t.getPreference()).toBe('dark');
    act(() => t.setPreference('light'));
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true');
  });
});
