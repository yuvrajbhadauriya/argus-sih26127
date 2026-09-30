// ═══════════════════════════════════════════════════
// MatrixHeat — origin × destination grid on a sequential primary ramp
// ═══════════════════════════════════════════════════

import { useState } from 'react';
import { useThemeTokens } from '@/shared/theme/tokens';
import { ChartTooltip, SrTable, TooltipRow } from './ChartTooltip';
import { fmtInt, luminance, mixHex, useElementWidth } from './chartUtils';

export interface MatrixCell {
  count: number;
  /** Extra tooltip rows. */
  extra?: { label: string; value: string }[];
}

export interface MatrixHeatProps {
  rows: string[];
  cols: string[];
  /** cells[row][col] */
  cells: MatrixCell[][];
  ariaLabel: string;
  rowTitle: string;
  colTitle: string;
  valueLabel: string;
}

export function MatrixHeat({ rows, cols, cells, ariaLabel, rowTitle, colTitle, valueLabel }: MatrixHeatProps) {
  const t = useThemeTokens();
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ r: number; c: number } | null>(null);
  const max = Math.max(1, ...cells.flat().map((c) => c.count));
  const labelW = Math.min(150, Math.max(100, width * 0.22));
  const headH = 44;
  const cellW = Math.max(44, (width - labelW) / Math.max(1, cols.length));
  const cellH = 40;
  const svgW = labelW + cellW * cols.length;
  const svgH = headH + cellH * rows.length;

  const colorOf = (n: number) => (n === 0 ? t.surface2 : mixHex(t.surface, t.primary, 0.08 + 0.82 * (n / max)));

  return (
    <div ref={ref} className="relative w-full overflow-x-auto">
      <svg width={svgW} height={svgH} role="img" aria-label={ariaLabel} className="block" onMouseLeave={() => setHover(null)}>
        <text x={labelW - 8} y={12} textAnchor="end" fontSize={11} fontWeight={600} fill="var(--fg-subtle)" letterSpacing="0.06em">
          {`${rowTitle.toUpperCase()} / ${colTitle.toUpperCase()}`}
        </text>
        {cols.map((c, j) => (
          <text key={c} x={labelW + j * cellW + cellW / 2} y={headH - 10} textAnchor="middle" fontSize={11} fill="var(--fg-muted)">
            {c.length > 14 && cellW < 110 ? `${c.slice(0, 12)}…` : c}
          </text>
        ))}
        {rows.map((r, i) => (
          <g key={r}>
            <text x={labelW - 8} y={headH + i * cellH + cellH / 2} textAnchor="end" dominantBaseline="central" fontSize={12} fill="var(--fg)">
              {r}
            </text>
            {cols.map((c, j) => {
              const cell = cells[i]?.[j] ?? { count: 0 };
              const bg = colorOf(cell.count);
              const fg = luminance(bg) > 0.4 ? '#0F1722' : '#FFFFFF';
              const active = hover?.r === i && hover?.c === j;
              return (
                <g key={c} onMouseEnter={() => setHover({ r: i, c: j })}>
                  <rect
                    x={labelW + j * cellW + 1}
                    y={headH + i * cellH + 1}
                    width={cellW - 2}
                    height={cellH - 2}
                    rx={3}
                    fill={bg}
                    stroke={active ? t.fg : 'none'}
                    strokeWidth={1.5}
                  />
                  <text
                    x={labelW + j * cellW + cellW / 2}
                    y={headH + i * cellH + cellH / 2}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={12}
                    fontWeight={i === j ? 500 : 600}
                    fill={cell.count === 0 ? t.fgSubtle : fg}
                    className="tabular-nums"
                  >
                    {cell.count === 0 ? '–' : fmtInt(cell.count)}
                  </text>
                </g>
              );
            })}
          </g>
        ))}
      </svg>
      {hover && (
        <ChartTooltip x={labelW + hover.c * cellW + cellW / 2} y={headH + (hover.r + 1) * cellH} width={width}>
          <div className="mb-1 font-semibold">
            {rows[hover.r]} <span className="text-fg-subtle">to</span> {cols[hover.c]}
          </div>
          <TooltipRow label={valueLabel} value={fmtInt(cells[hover.r][hover.c].count)} />
          {cells[hover.r][hover.c].extra?.map((e) => <TooltipRow key={e.label} label={e.label} value={e.value} />)}
        </ChartTooltip>
      )}
      <div className="mt-2 flex items-center gap-2 text-xs text-fg-muted" aria-hidden="true">
        <span className="tabular-nums">0</span>
        <span className="h-2 w-32 rounded-sm" style={{ background: `linear-gradient(90deg, ${colorOf(0.0001 * max)}, ${colorOf(max)})` }} />
        <span className="tabular-nums">{fmtInt(max)} {valueLabel.toLowerCase()}</span>
      </div>
      <SrTable
        caption={ariaLabel}
        headers={[`${rowTitle} \\ ${colTitle}`, ...cols]}
        rows={rows.map((r, i) => [r, ...cols.map((_, j) => cells[i]?.[j]?.count ?? 0)])}
      />
    </div>
  );
}
