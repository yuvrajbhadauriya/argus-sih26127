// ═══════════════════════════════════════════════════
// Tabs / TabPanel — WAI-ARIA tabs with roving focus
// ═══════════════════════════════════════════════════

import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/shared/lib/cn';
import { useScrollFade } from '@/shared/lib/useScrollFade';

export interface TabItem {
  id: string;
  label: string;
  icon?: ReactNode;
  count?: number;
}

export function Tabs({
  items,
  value,
  onChange,
  ariaLabel,
  variant = 'line',
  size = 'md',
  className,
}: {
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
  variant?: 'line' | 'segmented';
  size?: 'sm' | 'md';
  className?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const { attach: fadeRef, style: fadeStyle } = useScrollFade<HTMLDivElement>();

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % items.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    if (next < 0) return;
    e.preventDefault();
    refs.current[next]?.focus();
    onChange(items[next].id);
  };

  const line = variant === 'line';
  return (
    <div
      ref={fadeRef}
      style={fadeStyle}
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        'flex min-w-0 items-center',
        line
          ? cn('gap-4 overflow-x-auto border-b border-line [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', size === 'sm' ? 'h-9 touch:h-11' : 'h-10 touch:h-11')
          : 'inline-flex max-w-full gap-0.5 overflow-x-auto rounded-sm bg-surface-2 p-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className,
      )}
    >
      {items.map((t, i) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-controls={`panel-${t.id}`}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              'relative inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap font-medium transition-colors [&_svg]:h-3.5 [&_svg]:w-3.5',
              size === 'sm' ? 'text-xs' : 'text-[13px]',
              line
                ? cn(
                    'h-full px-0.5 touch:px-1',
                    active
                      ? 'text-fg after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary'
                      : 'text-fg-muted hover:text-fg',
                  )
                : cn(
                    'rounded-xs px-2.5',
                    size === 'sm' ? 'h-6 touch:h-10' : 'h-7 touch:h-10',
                    active ? 'bg-surface text-fg shadow-sm dark:bg-surface-3' : 'text-fg-muted hover:text-fg',
                  ),
            )}
          >
            {t.icon && <span className={cn('inline-flex', active && line && 'text-primary')} aria-hidden>{t.icon}</span>}
            {t.label}
            {t.count != null && (
              <span
                className={cn(
                  'inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] max-lg:text-2xs font-semibold tabular-nums leading-none',
                  active ? 'bg-primary/12 text-primary' : 'bg-surface-3 text-fg-muted',
                )}
              >
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ id, active, children, className }: { id: string; active: boolean; children: ReactNode; className?: string }) {
  if (!active) return null;
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} className={className}>
      {children}
    </div>
  );
}
