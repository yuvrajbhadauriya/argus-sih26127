// ═══════════════════════════════════════════════════
// MapPanel / MapLegend — docked chrome over a Leaflet map (z above panes)
// ═══════════════════════════════════════════════════

import { useState, type ReactNode } from 'react';
import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import { cn } from '@/shared/lib/cn';

export type MapCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

const POS: Record<MapCorner | 'bottom-center', string> = {
  'top-left': 'top-0 left-0',
  'top-right': 'top-0 right-0',
  'bottom-left': 'bottom-0 left-0',
  'bottom-right': 'bottom-0 right-0',
  'bottom-center': 'bottom-0 left-1/2 -translate-x-1/2',
};

export function MapPanel({
  position,
  children,
  className,
}: {
  position: MapCorner | 'bottom-center';
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'absolute z-[1000] m-3 rounded-md border border-line bg-surface/95 text-xs text-fg shadow-pop',
        POS[position],
        className,
      )}
      // Keep map drag/scroll from starting on the panel
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

export interface LegendItem {
  label: string;
  color: string;
  shape?: 'dot' | 'ring' | 'line' | 'dash' | 'square' | 'arrow';
  value?: ReactNode;
}

function Swatch({ color, shape = 'dot' }: { color: string; shape?: LegendItem['shape'] }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="shrink-0">
      {shape === 'dot' && <circle cx="6" cy="6" r="4.5" fill={color} stroke="var(--map-marker-halo)" strokeWidth="1.5" />}
      {shape === 'ring' && <circle cx="6" cy="6" r="4.25" fill="none" stroke={color} strokeWidth="2" />}
      {shape === 'line' && <line x1="0.5" y1="6" x2="11.5" y2="6" stroke={color} strokeWidth="3" strokeLinecap="round" />}
      {shape === 'dash' && <line x1="0.5" y1="6" x2="11.5" y2="6" stroke={color} strokeWidth="2.5" strokeDasharray="3 2" />}
      {shape === 'square' && <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" fill={color} />}
      {shape === 'arrow' && <path d="M2 10 L6 2 L10 10 L6 7.5 Z" fill={color} />}
    </svg>
  );
}

const STORAGE_PREFIX = 'nero.legend.';

function readCollapsed(key: string): boolean {
  try {
    return localStorage.getItem(STORAGE_PREFIX + key) === '1';
  } catch {
    return false;
  }
}

export function MapLegend({
  title = 'Legend',
  items = [],
  ramp,
  position = 'bottom-left',
  collapsible = true,
  className,
}: {
  title?: string;
  items?: LegendItem[];
  ramp?: { label: string; stops: string[]; min: string; max: string };
  position?: MapCorner;
  collapsible?: boolean;
  className?: string;
}) {
  const [collapsed, setCollapsed] = useState(() => (collapsible ? readCollapsed(title) : false));
  const toggle = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(STORAGE_PREFIX + title, c ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !c;
    });
  };

  return (
    <MapPanel position={position} className={cn('min-w-[140px] max-w-[240px]', className)}>
      <div className="flex h-8 items-center justify-between gap-2 px-2.5">
        <span className="text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">{title}</span>
        {collapsible && (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? `Show ${title.toLowerCase()}` : `Hide ${title.toLowerCase()}`}
            className="-mr-1 inline-flex h-6 w-6 items-center justify-center rounded-sm text-fg-subtle hover:bg-surface-2 hover:text-fg"
          >
            {collapsed ? <ChevronUpIcon size={14} aria-hidden /> : <ChevronDownIcon size={14} aria-hidden />}
          </button>
        )}
      </div>
      {!collapsed && (
        <div className="space-y-1.5 border-t border-line px-2.5 py-2">
          {items.map((it) => (
            <div key={it.label} className="flex items-center gap-2">
              <Swatch color={it.color} shape={it.shape} />
              <span className="flex-1 truncate text-fg-muted">{it.label}</span>
              {it.value != null && <span className="font-medium tabular-nums text-fg">{it.value}</span>}
            </div>
          ))}
          {ramp && (
            <div className={cn(items.length > 0 && 'pt-1')}>
              <div className="mb-1 text-fg-muted">{ramp.label}</div>
              <div className="h-2 rounded-xs" style={{ background: `linear-gradient(to right, ${ramp.stops.join(', ')})` }} aria-hidden />
              <div className="mt-0.5 flex justify-between text-2xs tabular-nums text-fg-subtle">
                <span>{ramp.min}</span>
                <span>{ramp.max}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </MapPanel>
  );
}
