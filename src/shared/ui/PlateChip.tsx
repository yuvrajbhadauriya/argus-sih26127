// ═══════════════════════════════════════════════════
// PlateChip — Indian HSRP number plate. A physical object, so its colours are
// constant in both themes (see PLATE_COLORS in shared/theme/tokens.ts).
// Helpers (formatPlate, normalizePlate, vehicleClassToPlateVariant) live in
// '@/shared/lib/plate'.
// ═══════════════════════════════════════════════════

import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/shared/lib/cn';
import { formatPlate, type PlateVariant } from '@/shared/lib/plate';
import { PLATE_COLORS } from '@/shared/theme/tokens';

export type PlateSize = 'xs' | 'sm' | 'md' | 'lg';

export interface PlateChipProps {
  plate: string;
  size?: PlateSize;
  variant?: PlateVariant;
  flag?: 'watchlist' | 'anomaly' | null;
  showStrip?: boolean;
  onClick?: () => void;
  to?: string;
  className?: string;
}

const SIZE: Record<PlateSize, { box: string; strip: string; stripText: string }> = {
  xs: { box: 'h-5 text-[11px] px-1.5', strip: 'w-[14px]', stripText: 'text-[7px]' },
  sm: { box: 'h-6 text-xs px-2', strip: 'w-[14px]', stripText: 'text-[7px]' },
  md: { box: 'h-7 text-sm px-2', strip: 'w-[18px]', stripText: 'text-[8px]' },
  lg: { box: 'h-10 text-xl px-3', strip: 'w-[18px]', stripText: 'text-[8px]' },
};

const FLAG_RING: Record<'watchlist' | 'anomaly', string> = {
  watchlist: 'ring-2 ring-sev-high ring-offset-1 ring-offset-surface',
  anomaly: 'ring-2 ring-danger ring-offset-1 ring-offset-surface',
};

export function PlateChip({ plate, size = 'sm', variant = 'private', flag = null, showStrip, onClick, to, className }: PlateChipProps) {
  const text = formatPlate(plate);
  const strip = showStrip ?? (size === 'md' || size === 'lg');
  const s = SIZE[size];
  const colors = PLATE_COLORS[variant];
  const style: CSSProperties = {
    backgroundColor: colors.bg,
    color: colors.fg,
    borderColor: PLATE_COLORS.border,
    boxShadow: `inset 0 0 0 1px ${PLATE_COLORS.inset}`,
  };

  const inner = (
    <>
      {strip && (
        <span
          aria-hidden
          className={cn('flex shrink-0 items-center justify-center self-stretch font-sans font-bold leading-none', s.strip, s.stripText)}
          style={{ backgroundColor: PLATE_COLORS.strip, color: PLATE_COLORS.stripFg }}
        >
          <span style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>IND</span>
        </span>
      )}
      <span className={cn('flex items-center whitespace-nowrap', s.box)}>{text}</span>
      {flag && <span className="sr-only">{flag === 'watchlist' ? ' (watchlist)' : ' (anomaly)'}</span>}
    </>
  );

  const cls = cn(
    'inline-flex shrink-0 items-stretch overflow-hidden rounded-[3px] border align-middle font-mono font-bold uppercase leading-none tracking-[0.06em] tabular-nums',
    'dark:ring-1 dark:ring-line-strong',
    flag && FLAG_RING[flag],
    (onClick || to) && 'cursor-pointer transition-opacity hover:opacity-85',
    className,
  );
  const label = `Plate ${text}${flag ? `, ${flag}` : ''}`;

  if (to) {
    return (
      <Link to={to} className={cls} style={style} aria-label={label} data-flag={flag ?? undefined}>
        {inner}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cls} style={style} aria-label={label} data-flag={flag ?? undefined}>
        {inner}
      </button>
    );
  }
  return (
    <span className={cls} style={style} aria-label={label} role="img" data-flag={flag ?? undefined}>
      {inner}
    </span>
  );
}

// Convenience re-exports so callers can import plate helpers alongside the chip.
// oxlint-disable-next-line react/only-export-components -- helper re-exports (public API)
export { formatPlate, normalizePlate, vehicleClassToPlateVariant } from '@/shared/lib/plate';
export type { PlateVariant } from '@/shared/lib/plate';
