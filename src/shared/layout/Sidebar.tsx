// ═══════════════════════════════════════════════════
// Sidebar — grouped primary navigation (232px / 56px collapsed)
// ═══════════════════════════════════════════════════

import { NavLink } from 'react-router-dom';
import {
  CctvIcon,
  ChartColumnIcon,
  MapIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  RouteIcon,
  ScanLineIcon,
  SettingsIcon,
  SirenIcon,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '@/shared/lib/cn';
import { Badge } from '@/shared/ui/Badge';
import { IconButton } from '@/shared/ui/Button';
import { NeroMark } from './NeroMark';
import { useNavBadges } from './useNavBadges';

interface NavItem {
  path: string;
  label: string;
  Icon: LucideIcon;
  badge?: 'alerts';
}

const NAV_GROUPS: { heading: string; items: NavItem[] }[] = [
  {
    heading: 'Operations',
    items: [
      { path: '/', label: 'Live Map', Icon: MapIcon },
      { path: '/cameras', label: 'Cameras', Icon: CctvIcon },
      { path: '/alerts', label: 'Alerts', Icon: SirenIcon, badge: 'alerts' },
    ],
  },
  {
    heading: 'Investigation',
    items: [
      { path: '/vehicles', label: 'Vehicle Trace', Icon: RouteIcon },
      { path: '/detections', label: 'Detections', Icon: ScanLineIcon },
    ],
  },
  { heading: 'Intelligence', items: [{ path: '/analytics', label: 'Analytics', Icon: ChartColumnIcon }] },
  { heading: 'System', items: [{ path: '/admin', label: 'Admin', Icon: SettingsIcon }] },
];

const STORAGE_KEY = 'nero.sidebar';
const LG_QUERY = '(min-width: 1024px)';

function readCollapsed(): boolean {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'collapsed') return true;
    if (v === 'expanded') return false;
  } catch {
    /* ignore */
  }
  try {
    return typeof window.matchMedia === 'function' ? !window.matchMedia(LG_QUERY).matches : false;
  } catch {
    return false;
  }
}

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const { alerts } = useNavBadges();

  // Auto-collapse when the viewport drops below lg.
  useEffect(() => {
    let mq: MediaQueryList | null = null;
    try {
      mq = typeof window.matchMedia === 'function' ? window.matchMedia(LG_QUERY) : null;
    } catch {
      mq = null;
    }
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => {
      if (!e.matches) setCollapsed(true);
    };
    mq.addEventListener?.('change', onChange);
    return () => mq?.removeEventListener?.('change', onChange);
  }, []);

  const toggle = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(STORAGE_KEY, c ? 'expanded' : 'collapsed');
      } catch {
        /* ignore */
      }
      return !c;
    });
  };

  return (
    <aside
      data-collapsed={collapsed || undefined}
      className={cn(
        'relative z-30 flex shrink-0 flex-col border-r border-line bg-surface transition-[width] duration-150',
        collapsed ? 'w-14' : 'w-[232px]',
      )}
    >
      {/* Brand */}
      <div className={cn('flex h-[52px] shrink-0 items-center gap-2.5 border-b border-line', collapsed ? 'justify-center px-0' : 'px-4')}>
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-primary/12 text-primary">
          <NeroMark size={16} />
        </span>
        {!collapsed && (
          <div className="min-w-0 leading-tight">
            <div className="text-sm font-bold tracking-[0.08em] text-fg">NERO</div>
            <div className="truncate text-2xs text-fg-subtle">City ANPR Intelligence</div>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav aria-label="Primary" className="flex-1 overflow-y-auto overflow-x-hidden px-2 py-3">
        {NAV_GROUPS.map((group, gi) => (
          <div key={group.heading} className={cn(gi > 0 && 'mt-4')}>
            {collapsed ? (
              gi > 0 && <div aria-hidden className="mx-2 mb-3 h-px bg-line" />
            ) : (
              <div className="mb-1 px-2 text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">{group.heading}</div>
            )}
            <ul className="space-y-0.5">
              {group.items.map(({ path, label, Icon, badge }) => {
                const count = badge === 'alerts' ? alerts : 0;
                return (
                  <li key={path}>
                    <NavLink
                      to={path}
                      end={path === '/'}
                      title={collapsed ? label : undefined}
                      aria-label={collapsed ? (count > 0 ? `${label} (${count} unacknowledged)` : label) : undefined}
                      className={({ isActive }) =>
                        cn(
                          'group relative flex h-8 items-center gap-2.5 rounded-sm text-[13px] font-medium transition-colors',
                          collapsed ? 'justify-center px-0' : 'px-2.5',
                          isActive ? 'bg-surface-3 text-fg' : 'text-fg-muted hover:bg-surface-2 hover:text-fg',
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          {isActive && <span aria-hidden className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary" />}
                          <Icon size={16} strokeWidth={1.75} className={cn('shrink-0', isActive && 'text-primary')} aria-hidden />
                          {!collapsed && <span className="truncate">{label}</span>}
                          {count > 0 &&
                            (collapsed ? (
                              <span aria-hidden className="absolute right-2.5 top-1.5 h-1.5 w-1.5 rounded-full bg-danger ring-2 ring-surface" />
                            ) : (
                              <Badge tone="danger" variant="solid" size="sm" className="ml-auto" title={`${count} unacknowledged alerts`}>
                                {count}
                              </Badge>
                            ))}
                        </>
                      )}
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className={cn('flex shrink-0 items-center gap-2 border-t border-line p-2', collapsed ? 'flex-col' : 'justify-between')}>
        {!collapsed && <span className="truncate pl-1.5 text-2xs text-fg-subtle">SIH 2026 · SIH26127 · Prototype</span>}
        <IconButton
          label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          icon={collapsed ? <PanelLeftOpenIcon size={16} strokeWidth={1.75} /> : <PanelLeftCloseIcon size={16} strokeWidth={1.75} />}
          onClick={toggle}
        />
      </div>
    </aside>
  );
}
