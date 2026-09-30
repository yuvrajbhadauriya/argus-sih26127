// Shared helpers for the in-house SVG charts (no chart library).

import { useEffect, useRef, useState } from 'react';

/** Width of a container element, tracked with ResizeObserver (fallback: `initial`). */
export function useElementWidth<T extends HTMLElement>(initial = 600) {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setWidth(Math.round(w));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

/** "Nice" rounded axis maximum and tick step for 0..max. */
export function niceScale(max: number, ticks = 4): { max: number; step: number } {
  if (!(max > 0)) return { max: 1, step: 1 };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  return { max: Math.ceil(max / step) * step, step };
}

export const fmtInt = (n: number) => Math.round(n).toLocaleString('en-IN');

/** Mix two #RRGGBB colours; t = 0 → a, 1 → b. */
export function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (p: number, s: number) => (p >> s) & 255;
  const out = [16, 8, 0].map((s) => Math.round(ch(pa, s) + (ch(pb, s) - ch(pa, s)) * t));
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Relative luminance of #RRGGBB (0 = black, 1 = white). */
export function luminance(hex: string): number {
  const p = parseInt(hex.slice(1), 16);
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((p >> 16) & 255) + 0.7152 * lin((p >> 8) & 255) + 0.0722 * lin(p & 255);
}

/** Rounded-top bar path (4px data-end radius, square at the baseline). */
export function barPath(x: number, y: number, w: number, h: number, horizontal = false, r = 4): string {
  if (w <= 0 || h <= 0) return '';
  if (horizontal) {
    const rr = Math.min(r, w, h / 2);
    return `M${x},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h - rr}Q${x + w},${y + h} ${x + w - rr},${y + h}H${x}Z`;
  }
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}
