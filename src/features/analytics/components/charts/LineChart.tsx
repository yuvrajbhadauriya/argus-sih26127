// ═══════════════════════════════════════════════════
// LineChart — multi-series lines with a crosshair tooltip, in-house SVG
// ═══════════════════════════════════════════════════

import { useState } from 'react';
import { ChartTooltip, SrTable, TooltipRow } from './ChartTooltip';
import { fmtInt, niceScale, useElementWidth } from './chartUtils';

export interface LineSeries {
  name: string;
  values: number[];
  /** CSS colour (use var(--series-n) in fixed order). */
  color: string;
}

export interface LineChartProps {
  series: LineSeries[];
  /** One label per x position. */
  xLabels: string[];
  ariaLabel: string;
  valueLabel: string;
  height?: number;
  format?: (n: number) => string;
  labelEvery?: number;
  /** x indices shaded as the active window. */
  band?: number[];
}

const AXIS = { fontSize: 11, fill: 'var(--fg-subtle)' } as const;

export function LineChart({ series, xLabels, ariaLabel, valueLabel, height = 220, format = fmtInt, labelEvery = 3, band = [] }: LineChartProps) {
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const [hi, setHi] = useState<number | null>(null);
  const n = xLabels.length;
  const max = Math.max(0, ...series.flatMap((s) => s.values));
  const scale = niceScale(max);
  const padL = 40;
  const padR = 8;
  const padT = 8;
  const padB = 22;
  const plotW = Math.max(40, width - padL - padR);
  const plotH = height - padT - padB;
  const xOf = (i: number) => padL + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  const yOf = (v: number) => padT + plotH - (scale.max ? (v / scale.max) * plotH : 0);
  const ticks = Array.from({ length: Math.round(scale.max / scale.step) + 1 }, (_, i) => i * scale.step);
  const bandSet = new Set(band);
  const step = n > 1 ? plotW / (n - 1) : plotW;

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const x = e.nativeEvent.offsetX - padL;
    setHi(Math.max(0, Math.min(n - 1, Math.round(x / step))));
  };

  return (
    <div ref={ref} className="relative w-full">
      <svg width={width} height={height} role="img" aria-label={ariaLabel} className="block">
        {xLabels.map((_, i) =>
          bandSet.has(i) ? (
            <rect key={`b${i}`} x={xOf(i) - step / 2} y={padT} width={step} height={plotH} style={{ fill: 'color-mix(in srgb, var(--primary) 7%, transparent)' }} />
          ) : null,
        )}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={padL + plotW} y1={yOf(t)} y2={yOf(t)} stroke="var(--line)" strokeDasharray={t === 0 ? undefined : '2 3'} />
            <text x={padL - 6} y={yOf(t)} textAnchor="end" dominantBaseline="central" {...AXIS} className="tabular-nums">
              {format(t)}
            </text>
          </g>
        ))}
        {xLabels.map((l, i) =>
          i % labelEvery === 0 ? (
            <text key={l} x={xOf(i)} y={height - 6} textAnchor="middle" {...AXIS} className="tabular-nums">
              {l}
            </text>
          ) : null,
        )}
        {series.map((s) => (
          <polyline
            key={s.name}
            points={s.values.map((v, i) => `${xOf(i)},${yOf(v)}`).join(' ')}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {hi != null && (
          <g pointerEvents="none">
            <line x1={xOf(hi)} x2={xOf(hi)} y1={padT} y2={padT + plotH} stroke="var(--fg-subtle)" strokeDasharray="3 3" />
            {series.map((s) => (
              <circle key={s.name} cx={xOf(hi)} cy={yOf(s.values[hi] ?? 0)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
            ))}
          </g>
        )}
        <rect x={padL} y={padT} width={plotW} height={plotH} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHi(null)} />
      </svg>
      {hi != null && (
        <ChartTooltip x={xOf(hi)} y={padT + 8} width={width}>
          <div className="mb-1 font-semibold tabular-nums">{xLabels[hi]} IST</div>
          {[...series]
            .sort((a, b) => (b.values[hi] ?? 0) - (a.values[hi] ?? 0))
            .map((s) => (
              <TooltipRow key={s.name} label={s.name} value={format(s.values[hi] ?? 0)} swatch={s.color} />
            ))}
        </ChartTooltip>
      )}
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted" aria-label="Legend">
        {series.map((s) => (
          <li key={s.name} className="flex items-center gap-1.5">
            <svg width="14" height="8" aria-hidden="true">
              <line x1="0" x2="14" y1="4" y2="4" stroke={s.color} strokeWidth="2" strokeLinecap="round" />
            </svg>
            {s.name}
          </li>
        ))}
      </ul>
      <SrTable
        caption={`${ariaLabel} (${valueLabel})`}
        headers={['Time', ...series.map((s) => s.name)]}
        rows={xLabels.map((l, i) => [l, ...series.map((s) => format(s.values[i] ?? 0))])}
      />
    </div>
  );
}
