import type { ReactNode } from 'react';

/** Floating tooltip panel positioned inside a relative chart container. */
export function ChartTooltip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const left = Math.max(4, Math.min(x + 12, width - 184));
  return (
    <div
      role="presentation"
      className="pointer-events-none absolute z-10 w-[180px] rounded-md border border-line bg-surface px-2.5 py-2 text-xs text-fg shadow-pop"
      style={{ left, top: Math.max(0, y - 8) }}
    >
      {children}
    </div>
  );
}

export function TooltipRow({ label, value, swatch }: { label: ReactNode; value: ReactNode; swatch?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 leading-5">
      <span className="flex min-w-0 items-center gap-1.5 text-fg-muted">
        {swatch && <span aria-hidden="true" className="inline-block h-2 w-2 shrink-0 rounded-[2px]" style={{ background: swatch }} />}
        <span className="truncate">{label}</span>
      </span>
      <span className="font-medium tabular-nums text-fg">{value}</span>
    </div>
  );
}

/** Screen-reader data table fallback for a chart. */
export function SrTable({ caption, headers, rows }: { caption: string; headers: string[]; rows: (string | number)[][] }) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>{headers.map((h) => <th key={h} scope="col">{h}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>{r.map((c, k) => (k === 0 ? <th key={k} scope="row">{c}</th> : <td key={k}>{c}</td>))}</tr>
        ))}
      </tbody>
    </table>
  );
}
