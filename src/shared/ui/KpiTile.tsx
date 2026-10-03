// ═══════════════════════════════════════════════════
// KpiTile / KpiStrip — headline numbers
// ═══════════════════════════════════════════════════

import type { ReactNode } from 'react';
import { MinusIcon, TrendingDownIcon, TrendingUpIcon } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { Skeleton } from './Skeleton';

export type KpiTone = 'default' | 'success' | 'warning' | 'danger' | 'info';

const ICON_TONE: Record<KpiTone, string> = {
  default: 'bg-surface-2 text-fg-muted',
  success: 'bg-success/12 text-success',
  warning: 'bg-warning/12 text-warning',
  danger: 'bg-danger/12 text-danger',
  info: 'bg-info/12 text-info',
};

export interface KpiTileProps {
  label: string;
  value: ReactNode;
  unit?: string;
  icon?: ReactNode;
  hint?: ReactNode;
  tone?: KpiTone;
  delta?: { value: string; direction: 'up' | 'down' | 'flat'; good?: boolean };
  loading?: boolean;
  onClick?: () => void;
  className?: string;
}

export function KpiTile({ label, value, unit, icon, hint, tone = 'default', delta, loading = false, onClick, className }: KpiTileProps) {
  const DeltaIcon = delta?.direction === 'up' ? TrendingUpIcon : delta?.direction === 'down' ? TrendingDownIcon : MinusIcon;
  const deltaCls = delta?.good == null ? 'text-fg-muted' : delta.good ? 'text-success' : 'text-danger';
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 break-words text-2xs font-semibold uppercase leading-tight tracking-[0.06em] text-fg-subtle lg:truncate lg:leading-[inherit]">{label}</span>
        {icon && (
          <span className={cn('inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm [&>svg]:h-3.5 [&>svg]:w-3.5', ICON_TONE[tone])} aria-hidden>
            {icon}
          </span>
        )}
      </div>
      {loading ? (
        <Skeleton className="mt-2 h-6 w-20" />
      ) : (
        <div className="mt-1 flex items-baseline gap-1">
          <span className="text-2xl font-semibold leading-7 tabular-nums text-fg">{value}</span>
          {unit && <span className="text-[13px] text-fg-muted">{unit}</span>}
        </div>
      )}
      {(delta || hint) && (
        <div className="mt-1 flex min-h-4 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
          {delta && !loading && (
            <span className={cn('inline-flex items-center gap-0.5 font-medium tabular-nums', deltaCls)}>
              <DeltaIcon size={12} aria-hidden />
              {delta.value}
            </span>
          )}
          {hint && <span className="inline-flex min-w-0 items-center gap-1">{hint}</span>}
        </div>
      )}
    </>
  );

  const base = cn('flex min-w-0 flex-col rounded-md border border-line bg-surface p-3 text-left', className);
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cn(base, 'transition-colors hover:border-line-strong hover:bg-surface-2')}>
        {body}
      </button>
    );
  }
  return <div className={base}>{body}</div>;
}

const STRIP_COLS: Record<3 | 4 | 5 | 6, string> = {
  3: 'md:grid-cols-3',
  4: 'md:grid-cols-2 xl:grid-cols-4',
  5: 'md:grid-cols-3 xl:grid-cols-5',
  6: 'md:grid-cols-3 xl:grid-cols-6',
};

/** Grid of KpiTiles. `cols` sets the column count at xl (default 5); className can still override. */
export function KpiStrip({ children, className, cols = 5 }: { children: ReactNode; className?: string; cols?: 3 | 4 | 5 | 6 }) {
  return <div className={cn('grid grid-cols-2 gap-3', STRIP_COLS[cols], className)}>{children}</div>;
}
