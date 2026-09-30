// ═══════════════════════════════════════════════════
// BarChart — vertical or horizontal bars, in-house SVG
// ═══════════════════════════════════════════════════

import { useState, type ReactNode } from 'react';
import { ChartTooltip, SrTable, TooltipRow } from './ChartTooltip';
import { barPath, fmtInt, niceScale, useElementWidth } from './chartUtils';

export interface BarDatum {
  key: string;
  label: string;
  value: number;
  /** Secondary line under the label (horizontal) / in the tooltip. */
  sub?: string;
  /** Extra tooltip rows. */
  extra?: { label: string; value: string }[];
}

export interface BarChartProps {
  data: BarDatum[];
  ariaLabel: string;
  /** Name of the measure, e.g. "Sightings". */
  valueLabel: string;
  orientation?: 'vertical' | 'horizontal';
  /** Plot height for vertical charts (px). */
  height?: number;
  format?: (n: number) => string;
  /** Bar colour (CSS colour; defaults to the first series colour). */
  color?: string;
  /** Per-bar colour override. */
  colorFor?: (d: BarDatum) => string | undefined;
  /** Bars drawn muted (e.g. outside the selected time window). */
  muted?: (d: BarDatum) => boolean;
  /** Bar called out with an annotation above it (vertical) — e.g. the current hour. */
  marker?: { key: string; label: string } | null;
  /** Show every n-th category label (vertical). */
  labelEvery?: number;
  /** Width of the label column (horizontal). */
  labelWidth?: number;
  /** Optional legend under the chart. */
  footer?: ReactNode;
}

const AXIS = { fontSize: 11, fill: 'var(--fg-subtle)' } as const;

export function BarChart({
  data,
  ariaLabel,
  valueLabel,
  orientation = 'vertical',
  height = 200,
  format = fmtInt,
  color = 'var(--series-1)',
  colorFor,
  muted,
  marker = null,
  labelEvery = 1,
  labelWidth = 150,
  footer,
}: BarChartProps) {
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const max = Math.max(0, ...data.map((d) => d.value));
  const scale = niceScale(max);
  const fill = (d: BarDatum) =>
    muted?.(d) ? 'color-mix(in srgb, var(--fg-subtle) 35%, var(--surface))' : colorFor?.(d) ?? color;

  const table = (
    <SrTable caption={ariaLabel} headers={['Category', valueLabel]} rows={data.map((d) => [d.label, format(d.value)])} />
  );
  const tip = hover && data[hover.i] && (
    <ChartTooltip x={hover.x} y={hover.y} width={width}>
      <div className="mb-1 font-semibold">{data[hover.i].label}</div>
      {data[hover.i].sub && <div className="mb-1 text-fg-subtle">{data[hover.i].sub}</div>}
      <TooltipRow label={valueLabel} value={format(data[hover.i].value)} swatch={fill(data[hover.i])} />
      {data[hover.i].extra?.map((e) => <TooltipRow key={e.label} label={e.label} value={e.value} />)}
    </ChartTooltip>
  );

  if (orientation === 'horizontal') {
    const row = 26;
    const valueW = 56;
    const plotW = Math.max(40, width - labelWidth - valueW);
    const h = data.length * row;
    return (
      <div ref={ref} className="relative w-full" onMouseLeave={() => setHover(null)}>
        <svg width={width} height={h} role="img" aria-label={ariaLabel} className="block overflow-visible">
          {[0.25, 0.5, 0.75, 1].map((t) => (
            <line key={t} x1={labelWidth + plotW * t} x2={labelWidth + plotW * t} y1={0} y2={h} stroke="var(--line)" strokeDasharray="2 3" />
          ))}
          {data.map((d, i) => {
            const w = scale.max ? (d.value / scale.max) * plotW : 0;
            const y = i * row;
            return (
              <g
                key={d.key}
                onMouseMove={(e) => setHover({ i, x: e.nativeEvent.offsetX, y: y + row })}
                opacity={hover && hover.i !== i ? 0.55 : 1}
              >
                <rect x={0} y={y} width={width} height={row} fill="transparent" />
                <text x={0} y={y + row / 2} dominantBaseline="central" fontSize={12} fill="var(--fg)" className="font-medium">
                  {d.label.length > 22 ? `${d.label.slice(0, 21)}…` : d.label}
                </text>
                <path d={barPath(labelWidth, y + 6, Math.max(w, d.value > 0 ? 2 : 0), row - 12, true)} style={{ fill: fill(d) }} />
                <text x={labelWidth + w + 6} y={y + row / 2} dominantBaseline="central" fontSize={11} fill="var(--fg-muted)" className="tabular-nums">
                  {format(d.value)}
                </text>
              </g>
            );
          })}
        </svg>
        {tip}
        {table}
        {footer}
      </div>
    );
  }

  const padL = 40;
  const padB = 22;
  const padT = marker ? 16 : 6;
  const plotW = Math.max(40, width - padL - 4);
  const plotH = height - padB - padT;
  const band = data.length ? plotW / data.length : plotW;
  const barW = Math.max(2, Math.min(28, band - 2));
  const ticks = Array.from({ length: Math.round(scale.max / scale.step) + 1 }, (_, i) => i * scale.step);
  const yOf = (v: number) => padT + plotH - (scale.max ? (v / scale.max) * plotH : 0);

  return (
    <div ref={ref} className="relative w-full" onMouseLeave={() => setHover(null)}>
      <svg width={width} height={height} role="img" aria-label={ariaLabel} className="block">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={padL + plotW} y1={yOf(t)} y2={yOf(t)} stroke="var(--line)" strokeDasharray={t === 0 ? undefined : '2 3'} />
            <text x={padL - 6} y={yOf(t)} textAnchor="end" dominantBaseline="central" {...AXIS} className="tabular-nums">
              {format(t)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = padL + i * band + (band - barW) / 2;
          const y = yOf(d.value);
          const isMarker = marker?.key === d.key;
          return (
            <g
              key={d.key}
              onMouseMove={() => setHover({ i, x: x + barW, y })}
              opacity={hover && hover.i !== i ? 0.6 : 1}
            >
              <rect x={padL + i * band} y={padT} width={band} height={plotH} fill="transparent" />
              <path d={barPath(x, y, barW, padT + plotH - y)} style={{ fill: fill(d) }} />
              {isMarker && (
                <>
                  <path d={barPath(x, y, barW, padT + plotH - y)} fill="none" stroke="var(--fg)" strokeWidth={1.5} />
                  <text x={x + barW / 2} y={y - 5} textAnchor="middle" fontSize={11} fontWeight={600} fill="var(--fg)">
                    {marker!.label}
                  </text>
                </>
              )}
              {i % labelEvery === 0 && (
                <text x={x + barW / 2} y={height - 6} textAnchor="middle" {...AXIS} className="tabular-nums">
                  {d.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {tip}
      {table}
      {footer}
    </div>
  );
}
