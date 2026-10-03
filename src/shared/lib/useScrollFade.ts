// Edge fades for a horizontally scrolling strip: a soft mask appears on the
// side(s) that still have hidden content, so users can tell it scrolls.

import { useCallback, useEffect, useState, type CSSProperties } from 'react';

const FADE = 24;

export function useScrollFade<T extends HTMLElement>() {
  const [el, attach] = useState<T | null>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  const update = useCallback(() => {
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const start = el.scrollLeft > 2;
    const end = max - el.scrollLeft > 2;
    setEdges((e) => (e.start === start && e.end === end ? e : { start, end }));
  }, [el]);

  useEffect(() => {
    if (!el) return;
    const raf = requestAnimationFrame(update);
    el.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      ro?.disconnect();
    };
  }, [el, update]);

  let style: CSSProperties | undefined;
  if (edges.start || edges.end) {
    const mask = `linear-gradient(to right, ${edges.start ? 'transparent 0' : '#000 0'}, #000 ${FADE}px, #000 calc(100% - ${FADE}px), ${edges.end ? 'transparent 100%' : '#000 100%'})`;
    style = { WebkitMaskImage: mask, maskImage: mask };
  }
  return { attach, style };
}
