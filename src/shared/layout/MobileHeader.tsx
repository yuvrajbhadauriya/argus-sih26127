// ═══════════════════════════════════════════════════
// MobileHeader — compact top bar for phones (< 768px): logo, search button
// (opens a full-width search row), status dot, bell, theme toggle, user menu.
// Every control is a 40px target and the row fits 360px without clipping.
// ═══════════════════════════════════════════════════

import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BellIcon, SearchIcon } from 'lucide-react';
import { IconButton } from '@/shared/ui/Button';
import { GlobalPlateSearch } from './GlobalPlateSearch';
import { NeroMark } from './NeroMark';
import { ThemeToggle } from './ThemeToggle';
import { UserMenu } from './UserMenu';
import { useNavBadges } from './useNavBadges';

const SystemStatus = lazy(() => import('./SystemStatus'));

const HEADER =
  'relative z-[1100] flex h-14 shrink-0 items-center gap-1 border-b border-line bg-surface pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.5rem,env(safe-area-inset-right))] pt-[env(safe-area-inset-top)] box-content';

export function MobileHeader() {
  const navigate = useNavigate();
  const { alerts } = useNavBadges();
  const [searching, setSearching] = useState(false);
  const searchBtn = useRef<HTMLButtonElement>(null);
  const wasSearching = useRef(false);

  // Hand focus back to the search button when the overlay closes.
  useEffect(() => {
    if (wasSearching.current && !searching) searchBtn.current?.focus();
    wasSearching.current = searching;
  }, [searching]);

  if (searching) {
    return (
      <header className={HEADER}>
        <GlobalPlateSearch autoFocus onDone={() => setSearching(false)} className="flex-1" />
        <button
          type="button"
          onClick={() => setSearching(false)}
          className="ml-1 inline-flex h-10 shrink-0 items-center rounded-sm px-3 text-[13px] font-medium text-primary hover:bg-surface-2"
        >
          Cancel
        </button>
      </header>
    );
  }

  return (
    <header className={HEADER}>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-primary/12 text-primary">
          <NeroMark size={16} />
        </span>
        <span className="truncate text-sm font-bold tracking-[0.08em] text-fg">NERO</span>
      </div>
      <IconButton
        ref={searchBtn}
        label="Search vehicle plate"
        aria-haspopup="dialog"
        icon={<SearchIcon size={18} strokeWidth={1.75} />}
        onClick={() => setSearching(true)}
      />
      <Suspense fallback={<span aria-hidden className="inline-flex h-10 w-10" />}>
        <SystemStatus compact />
      </Suspense>
      <IconButton
        label={alerts > 0 ? `Alerts: ${alerts} unacknowledged` : 'Alerts'}
        icon={<BellIcon size={18} strokeWidth={1.75} />}
        badge={alerts}
        onClick={() => navigate('/alerts')}
      />
      <ThemeToggle />
      <UserMenu />
    </header>
  );
}
