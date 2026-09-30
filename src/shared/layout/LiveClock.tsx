// ═══════════════════════════════════════════════════
// LiveClock — 1 Hz ticking time. Kept in its own tiny component so the
// per-second state update re-renders just this <span>, not the whole TopBar.
// ═══════════════════════════════════════════════════

import { useEffect, useState } from 'react';

const format = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function LiveClock({ className }: { className?: string }) {
  const [time, setTime] = useState(() => format(new Date()));

  useEffect(() => {
    // Align ticks to the wall-clock second so the display never skips.
    let interval: number | undefined;
    const timeout = window.setTimeout(() => {
      setTime(format(new Date()));
      interval = window.setInterval(() => setTime(format(new Date())), 1000);
    }, 1000 - (Date.now() % 1000));
    return () => {
      window.clearTimeout(timeout);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, []);

  return <span className={className}>{time}</span>;
}
