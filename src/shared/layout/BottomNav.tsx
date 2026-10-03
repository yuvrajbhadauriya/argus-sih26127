// ═══════════════════════════════════════════════════
// BottomNav — phone navigation (< 768px). Four primary tabs plus "More",
// which opens a sheet with the remaining pages. Replaces the desktop Sidebar
// on phones; sits in the shell's flex column so it never covers page content,
// and pads for the iOS home indicator.
// ═══════════════════════════════════════════════════

import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { EllipsisIcon } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { BottomSheet } from '@/shared/ui/BottomSheet';
import { BOTTOM_TABS, MORE_ITEMS, type NavItem } from './navItems';
import { useNavBadges } from './useNavBadges';

const TAB =
  'relative flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-2xs font-medium leading-tight transition-colors';

function isActivePath(pathname: string, path: string): boolean {
  return path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(path + '/');
}

function UnackBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      aria-hidden
      className="absolute -right-2.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger-solid px-1 text-2xs font-semibold leading-none text-white tabular-nums ring-2 ring-surface"
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

function tabLabel(item: NavItem, alerts: number) {
  return item.badge === 'alerts' && alerts > 0 ? `${item.label} (${alerts} unacknowledged)` : undefined;
}

export function BottomNav() {
  const [moreOpen, setMoreOpen] = useState(false);
  const { pathname } = useLocation();
  const { alerts } = useNavBadges();
  const moreActive = MORE_ITEMS.some((i) => isActivePath(pathname, i.path));

  return (
    <>
      <nav
        aria-label="Primary"
        className="relative z-30 shrink-0 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
      >
        <ul className="flex items-stretch">
          {BOTTOM_TABS.map((item) => {
            const count = item.badge === 'alerts' ? alerts : 0;
            return (
              <li key={item.path} className="flex min-w-0 flex-1">
                <NavLink
                  to={item.path}
                  end={item.path === '/'}
                  aria-label={tabLabel(item, alerts)}
                  className={({ isActive }) => cn(TAB, isActive ? 'text-primary' : 'text-fg-muted active:bg-surface-2')}
                >
                  {({ isActive }) => (
                    <>
                      {isActive && <span aria-hidden className="absolute inset-x-4 top-0 h-0.5 rounded-b-full bg-primary" />}
                      <span className="relative inline-flex">
                        <item.Icon size={20} strokeWidth={isActive ? 2.25 : 1.75} aria-hidden />
                        <UnackBadge count={count} />
                      </span>
                      <span className="max-w-full truncate">{item.label}</span>
                    </>
                  )}
                </NavLink>
              </li>
            );
          })}
          <li className="flex min-w-0 flex-1">
            <button
              type="button"
              aria-haspopup="dialog"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen(true)}
              data-active={moreActive || undefined}
              className={cn(TAB, moreActive ? 'text-primary' : 'text-fg-muted active:bg-surface-2')}
            >
              {moreActive && <span aria-hidden className="absolute inset-x-4 top-0 h-0.5 rounded-b-full bg-primary" />}
              <EllipsisIcon size={20} strokeWidth={moreActive ? 2.25 : 1.75} aria-hidden />
              <span>More</span>
            </button>
          </li>
        </ul>
      </nav>

      <BottomSheet open={moreOpen} onClose={() => setMoreOpen(false)} title="More">
        <nav aria-label="More pages">
          <ul className="grid gap-0.5">
            {MORE_ITEMS.map(({ path, label, Icon }) => (
              <li key={path}>
                <NavLink
                  to={path}
                  onClick={() => setMoreOpen(false)}
                  className={({ isActive }) =>
                    cn(
                      'flex min-h-12 items-center gap-3 rounded-md px-3 text-[15px] font-medium transition-colors',
                      isActive ? 'bg-surface-3 text-fg' : 'text-fg-muted active:bg-surface-2',
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      <Icon size={20} strokeWidth={1.75} className={cn('shrink-0', isActive && 'text-primary')} aria-hidden />
                      {label}
                    </>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </BottomSheet>
    </>
  );
}
