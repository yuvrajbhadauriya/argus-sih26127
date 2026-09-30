// ═══════════════════════════════════════════════════
// useInViewport — true while the element is (partly) on screen.
// Falls back to "always visible" where IntersectionObserver is missing.
// ═══════════════════════════════════════════════════

import { useEffect, useState, type RefObject } from 'react';

export function useInViewport(ref: RefObject<Element | null>, rootMargin = '0px', threshold = 0.25): boolean {
  const supported = typeof IntersectionObserver !== 'undefined';
  const [inView, setInView] = useState(!supported);

  useEffect(() => {
    const el = ref.current;
    if (!el || !supported) return;
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry) setInView(entry.isIntersecting && entry.intersectionRatio >= threshold);
      },
      { rootMargin, threshold: [0, threshold] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, rootMargin, threshold, supported]);

  return inView;
}
