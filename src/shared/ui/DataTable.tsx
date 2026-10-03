// ═══════════════════════════════════════════════════
// DataTable — compact, sortable, paginated data grid
// ═══════════════════════════════════════════════════

import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDownIcon, ArrowUpIcon, ChevronLeftIcon, ChevronRightIcon, ChevronsUpDownIcon } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { useIsPhone } from '@/shared/lib/useMediaQuery';
import { useScrollFade } from '@/shared/lib/useScrollFade';
import { IconButton } from './Button';
import { CardList, type CardRowContent } from './CardList';
import { Skeleton } from './Skeleton';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T, index: number) => ReactNode;
  width?: string;
  align?: 'left' | 'right' | 'center';
  mono?: boolean;
  sortValue?: (row: T) => string | number;
  hideBelow?: 'sm' | 'md' | 'lg';
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  density?: 'compact' | 'comfortable';
  onRowClick?: (row: T) => void;
  selectedKey?: string | null;
  stickyHeader?: boolean;
  maxHeight?: string;
  loading?: boolean;
  empty?: ReactNode;
  caption?: string;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  pageSize?: number;
  rowTone?: (row: T) => 'danger' | 'warning' | null;
  /** Phones (< 768px): render each row as a compact card instead of a table row. */
  renderCard?: (row: T, index: number) => CardRowContent;
  className?: string;
}

const HIDE: Record<NonNullable<Column<unknown>['hideBelow']>, string> = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
};
const ALIGN = { left: 'text-left', right: 'text-right', center: 'text-center' } as const;

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  density = 'compact',
  onRowClick,
  selectedKey = null,
  stickyHeader = true,
  maxHeight,
  loading = false,
  empty,
  caption,
  initialSort,
  pageSize,
  rowTone,
  renderCard,
  className,
}: DataTableProps<T>) {
  const phone = useIsPhone();
  const { attach: fadeRef, style: fadeStyle } = useScrollFade<HTMLDivElement>();
  const asCards = phone && !!renderCard && !loading;
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(initialSort ?? null);
  const [page, setPage] = useState(0);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const get = col.sortValue;
    const mul = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mul;
      return String(va).localeCompare(String(vb), undefined, { numeric: true }) * mul;
    });
  }, [rows, columns, sort]);

  const pageCount = pageSize ? Math.max(1, Math.ceil(sorted.length / pageSize)) : 1;
  const safePage = Math.min(page, pageCount - 1);
  const visible = pageSize ? sorted.slice(safePage * pageSize, safePage * pageSize + pageSize) : sorted;

  const toggleSort = (key: string) => {
    setPage(0);
    setSort((s) => (s?.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  };

  const cellPad = density === 'compact' ? 'h-8 px-3 py-1.5' : 'h-10 px-3 py-2';

  return (
    <div className={cn('flex min-w-0 flex-col', className)}>
      {asCards && visible.length > 0 ? (
        <CardList
          label={caption}
          rows={visible}
          rowKey={rowKey}
          render={(row, i) => renderCard!(row, safePage * (pageSize ?? 0) + i)}
          onRowClick={onRowClick}
          selectedKey={selectedKey}
          rowTone={rowTone}
          style={maxHeight ? { maxHeight } : undefined}
        />
      ) : (
      <div ref={fadeRef} className="min-w-0 overflow-auto" style={{ ...(maxHeight ? { maxHeight } : null), ...fadeStyle }}>
        <table className="w-full border-collapse text-[13px] text-fg">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead className={cn(stickyHeader && 'sticky top-0 z-[1]')}>
            <tr className="bg-surface-2">
              {columns.map((c) => {
                const active = sort?.key === c.key;
                const ariaSort = c.sortValue ? (active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none') : undefined;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={ariaSort}
                    style={c.width ? { width: c.width } : undefined}
                    className={cn(
                      'h-8 whitespace-nowrap border-b border-line px-3 text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle',
                      ALIGN[c.align ?? 'left'],
                      c.hideBelow && HIDE[c.hideBelow],
                    )}
                  >
                    {c.sortValue ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(c.key)}
                        className={cn('inline-flex items-center gap-1 uppercase hover:text-fg', active && 'text-fg')}
                      >
                        {c.header}
                        {active ? (
                          sort!.dir === 'asc' ? <ArrowUpIcon size={12} aria-hidden /> : <ArrowDownIcon size={12} aria-hidden />
                        ) : (
                          <ChevronsUpDownIcon size={12} className="opacity-50" aria-hidden />
                        )}
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 8 }, (_, r) => (
                <tr key={`sk-${r}`} className="border-b border-line">
                  {columns.map((c) => (
                    <td key={c.key} className={cn(cellPad, c.hideBelow && HIDE[c.hideBelow])}>
                      <Skeleton className="h-3 w-3/4" />
                    </td>
                  ))}
                </tr>
              ))
            ) : visible.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="p-0">
                  {empty ?? <div className="py-10 text-center text-xs text-fg-muted">No data</div>}
                </td>
              </tr>
            ) : (
              visible.map((row, i) => {
                const key = rowKey(row);
                const selected = selectedKey != null && key === selectedKey;
                const tone = rowTone?.(row) ?? null;
                return (
                  <tr
                    key={key}
                    data-selected={selected || undefined}
                    data-tone={tone ?? undefined}
                    aria-selected={onRowClick ? selected : undefined}
                    tabIndex={onRowClick ? 0 : undefined}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    onKeyDown={
                      onRowClick
                        ? (e) => {
                            if (e.key === 'Enter' && e.target === e.currentTarget) onRowClick(row);
                          }
                        : undefined
                    }
                    className={cn(
                      'border-b border-line transition-colors',
                      onRowClick && 'cursor-pointer focus-visible:-outline-offset-2',
                      selected ? 'bg-primary/8' : 'hover:bg-surface-2',
                    )}
                  >
                    {columns.map((c, ci) => (
                      <td
                        key={c.key}
                        className={cn(
                          cellPad,
                          'align-middle',
                          ALIGN[c.align ?? 'left'],
                          c.mono && 'font-mono text-xs tabular-nums',
                          c.hideBelow && HIDE[c.hideBelow],
                          ci === 0 && (selected || tone) && 'relative',
                        )}
                      >
                        {ci === 0 && (selected || tone) && (
                          <span
                            aria-hidden
                            className={cn(
                              'absolute inset-y-0 left-0 w-0.5',
                              selected ? 'bg-primary' : tone === 'danger' ? 'bg-danger' : 'bg-warning',
                            )}
                          />
                        )}
                        {c.cell(row, safePage * (pageSize ?? 0) + i)}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      )}
      {pageSize && !loading && sorted.length > pageSize && (
        <div className="flex min-h-10 shrink-0 items-center justify-end gap-2 border-t border-line px-3 text-xs text-fg-muted">
          <span className="tabular-nums">
            {safePage * pageSize + 1}–{Math.min(sorted.length, (safePage + 1) * pageSize)} of {sorted.length}
          </span>
          <IconButton
            size="sm"
            label="Previous page"
            icon={<ChevronLeftIcon size={16} />}
            disabled={safePage === 0}
            onClick={() => setPage(safePage - 1)}
          />
          <IconButton
            size="sm"
            label="Next page"
            icon={<ChevronRightIcon size={16} />}
            disabled={safePage >= pageCount - 1}
            onClick={() => setPage(safePage + 1)}
          />
        </div>
      )}
    </div>
  );
}
