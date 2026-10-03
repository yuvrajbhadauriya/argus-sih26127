// ═══════════════════════════════════════════════════
// CardList — phone rendering of table rows: one compact card per row.
// The card body is a single button (when the row is actionable); row actions
// sit beside it, so there are never nested interactive elements.
// ═══════════════════════════════════════════════════

import type { ReactNode } from 'react';
import { cn } from '@/shared/lib/cn';

export interface CardRowContent {
  /** Main content of the card (plate, time, camera, confidence …). */
  body: ReactNode;
  /** Optional trailing actions (icon buttons). */
  actions?: ReactNode;
}

export function CardList<T>({
  rows,
  rowKey,
  render,
  onRowClick,
  selectedKey = null,
  rowTone,
  label,
  className,
  style,
}: {
  rows: T[];
  rowKey: (row: T) => string;
  render: (row: T, index: number) => CardRowContent;
  onRowClick?: (row: T) => void;
  selectedKey?: string | null;
  rowTone?: (row: T) => 'danger' | 'warning' | null;
  label?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <ul aria-label={label} className={cn('min-w-0 divide-y divide-line overflow-y-auto', className)} style={style}>
      {rows.map((row, i) => {
        const key = rowKey(row);
        const selected = selectedKey != null && key === selectedKey;
        const tone = rowTone?.(row) ?? null;
        const { body, actions } = render(row, i);
        return (
          <li
            key={key}
            data-selected={selected || undefined}
            data-tone={tone ?? undefined}
            className={cn('relative flex items-stretch', selected && 'bg-primary/8')}
          >
            {(selected || tone) && (
              <span aria-hidden className={cn('absolute inset-y-0 left-0 w-0.5', selected ? 'bg-primary' : tone === 'danger' ? 'bg-danger' : 'bg-warning')} />
            )}
            {onRowClick ? (
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => onRowClick(row)}
                className="min-h-14 min-w-0 flex-1 px-3 py-2.5 text-left transition-colors active:bg-surface-2"
              >
                {body}
              </button>
            ) : (
              <div className="min-h-14 min-w-0 flex-1 px-3 py-2.5">{body}</div>
            )}
            {actions && <div className="flex shrink-0 items-center pr-2">{actions}</div>}
          </li>
        );
      })}
    </ul>
  );
}
