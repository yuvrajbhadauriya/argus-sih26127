// ═══════════════════════════════════════════════════
// LiveClock — 1 Hz ticking IST time. Kept in its own tiny component so the
// per-second state update re-renders just this element, not the whole TopBar.
// Always formats in Asia/Kolkata (24h), whatever the browser's time zone.
// ═══════════════════════════════════════════════════

import { useEffect, useState } from 'react';
import { formatIstDate, formatIstTime } from '@/shared/lib/time';

function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // Align ticks to the wall-clock second so the display never skips.
    let interval: number | undefined;
    const timeout = window.setTimeout(() => {
      setNow(new Date());
      interval = window.setInterval(() => setNow(new Date()), 1000);
    }, 1000 - (Date.now() % 1000));
    return () => {
      window.clearTimeout(timeout);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, []);
  return now;
}

export function LiveClock({ className, withDate = false }: { className?: string; withDate?: boolean }) {
  const now = useNow();
  if (!withDate) {
    return (
      <time className={className} dateTime={now.toISOString()}>
        {formatIstTime(now)}
      </time>
    );
  }
  return (
    <time className={className} dateTime={now.toISOString()} aria-label={`${formatIstTime(now)} IST, ${formatIstDate(now)}`}>
      <span className="block font-mono text-[13px] font-medium leading-4 tabular-nums text-fg">
        {formatIstTime(now)} <span className="text-2xs font-semibold text-fg-subtle">IST</span>
      </span>
      <span className="block text-2xs leading-4 text-fg-subtle">{formatIstDate(now)}</span>
    </time>
  );
}
