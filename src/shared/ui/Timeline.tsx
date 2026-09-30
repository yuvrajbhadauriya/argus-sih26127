// ═══════════════════════════════════════════════════
// Timeline — composable vertical timeline (journey stops, sightings)
// ═══════════════════════════════════════════════════

import type { ReactNode, Ref } from 'react';
import { cn } from '@/shared/lib/cn';

export function Timeline({ children, ariaLabel, className }: { children: ReactNode; ariaLabel: string; className?: string }) {
  return (
    <ol aria-label={ariaLabel} className={cn('relative flex flex-col', className)}>
      {children}
    </ol>
  );
}

/** Pick black or white text for a hex background (falls back to white for var()/named colours). */
function textOn(color: string | undefined): string {
  const m = color && /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return '#FFFFFF';
  const n = parseInt(m[1], 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.4 ? '#0B0F14' : '#FFFFFF';
}

export interface TimelineItemProps {
  marker: { label: string; color?: string };
  title: ReactNode;
  time: ReactNode;
  meta?: ReactNode;
  active?: boolean;
  tone?: 'default' | 'danger' | 'warning';
  onSelect?: () => void;
  itemRef?: Ref<HTMLLIElement>;
  last?: boolean;
}

export function TimelineItem({ marker, title, time, meta, active = false, tone = 'default', onSelect, itemRef, last = false }: TimelineItemProps) {
  const bg = marker.color ?? 'var(--primary)';
  const body = (
    <>
      <span
        aria-hidden
        className="relative z-[1] mt-0.5 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-2xs font-semibold tabular-nums ring-2 ring-surface"
        style={{ backgroundColor: bg, color: textOn(marker.color) }}
      >
        {marker.label}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className={cn('min-w-0 truncate text-[13px] font-medium', tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-fg')}>
            {title}
          </span>
          <span className="shrink-0 font-mono text-xs tabular-nums text-fg-muted">{time}</span>
        </span>
        {meta && <span className="mt-0.5 block text-xs text-fg-muted">{meta}</span>}
      </span>
    </>
  );

  const cls = cn(
    'relative flex w-full items-start gap-3 rounded-sm border px-2 py-2 text-left transition-colors',
    active ? 'border-primary/40 bg-primary/8' : tone === 'danger' ? 'border-danger/35 bg-danger/12' : tone === 'warning' ? 'border-warning/35 bg-warning/12' : 'border-transparent',
    onSelect && !active && 'hover:bg-surface-2',
  );

  return (
    <li ref={itemRef} className="relative" data-tone={tone} data-active={active || undefined}>
      {!last && <span aria-hidden className="absolute bottom-[-4px] left-[18px] top-7 w-0.5 bg-line" />}
      {onSelect ? (
        <button type="button" onClick={onSelect} aria-current={active ? 'step' : undefined} className={cls}>
          {body}
        </button>
      ) : (
        <div className={cls} aria-current={active ? 'step' : undefined}>
          {body}
        </div>
      )}
    </li>
  );
}

export function TimelineConnector({ children, color }: { children: ReactNode; color?: string }) {
  return (
    <li className="relative flex items-center py-0.5 pl-[42px] pr-2" aria-hidden={false}>
      <span
        aria-hidden
        className="absolute inset-y-0 left-[18px] w-0.5"
        style={{ backgroundColor: color ? `color-mix(in srgb, ${color} 40%, transparent)` : 'var(--line)' }}
      />
      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs tabular-nums text-fg-subtle">{children}</span>
    </li>
  );
}

export function TimelineDivider({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <li className="flex items-center gap-2 py-2 text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">
      {icon && <span className="inline-flex [&>svg]:h-3.5 [&>svg]:w-3.5" aria-hidden>{icon}</span>}
      <span className="shrink-0">{children}</span>
      <span aria-hidden className="h-px flex-1 bg-line" />
    </li>
  );
}
