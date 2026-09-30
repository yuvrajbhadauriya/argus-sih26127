// ═══════════════════════════════════════════════════
// SpeedDistribution — histogram of hop speeds with a p10–p90 box summary
// ═══════════════════════════════════════════════════

import { useState } from 'react';
import type { SpeedStats } from '../../lib/aggregate';
import { ChartTooltip, SrTable, TooltipRow } from './ChartTooltip';
import { barPath, fmtInt, niceScale, useElementWidth } from './chartUtils';

const AXIS = { fontSize: 11, fill: 'var(--fg-subtle)' } as const;

export function SpeedDistribution({ stats, height = 220, ariaLabel = 'Distribution of hop speeds' }: { stats: SpeedStats; height?: number; ariaLabel?: string }) {
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const bins = stats.histogram;
  const padL = 40;
  const padR = 8;
  const boxH = 30;
  const padT = 6;
  const padB = 22;
  const plotW = Math.max(60, width - padL - padR);
  const histH = height - padT - padB - boxH - 10;
  const xMax = bins.length ? bins[bins.length - 1].to : 60;
  const xOf = (v: number) => padL + (v / xMax) * plotW;
  const yScale = niceScale(Math.max(0, ...bins.map((b) => b.count)), 3);
  const yOf = (n: number) => padT + histH - (n / yScale.max) * histH;
  const ticks = Array.from({ length: Math.round(yScale.max / yScale.step) + 1 }, (_, i) => i * yScale.step);
  const boxY = padT + histH + 10;
  const mid = boxY + boxH / 2;
  const bw = plotW / Math.max(1, bins.length);

  return (
    <div ref={ref} className="relative w-full" onMouseLeave={() => setHover(null)}>
      <svg width={width} height={height} role="img" aria-label={ariaLabel} className="block">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={padL + plotW} y1={yOf(t)} y2={yOf(t)} stroke="var(--line)" strokeDasharray={t === 0 ? undefined : '2 3'} />
            <text x={padL - 6} y={yOf(t)} textAnchor="end" dominantBaseline="central" {...AXIS} className="tabular-nums">
              {fmtInt(t)}
            </text>
          </g>
        ))}
        {bins.map((b, i) => {
          const inBand = b.to > stats.p10 && b.from < stats.p90;
          return (
            <g key={b.from} onMouseEnter={() => setHover(i)} opacity={hover != null && hover !== i ? 0.6 : 1}>
              <rect x={xOf(b.from)} y={padT} width={bw} height={histH} fill="transparent" />
              <path
                d={barPath(xOf(b.from) + 1, yOf(b.count), bw - 2, padT + histH - yOf(b.count))}
                style={{ fill: inBand ? 'var(--series-2)' : 'color-mix(in srgb, var(--series-2) 40%, var(--surface))' }}
              />
            </g>
          );
        })}
        {/* box summary: whiskers p10–p90, box p25–p75, median, mean */}
        <line x1={xOf(stats.p10)} x2={xOf(stats.p90)} y1={mid} y2={mid} stroke="var(--fg-muted)" strokeWidth={1.5} />
        {[stats.p10, stats.p90].map((v) => (
          <line key={v} x1={xOf(v)} x2={xOf(v)} y1={mid - 7} y2={mid + 7} stroke="var(--fg-muted)" strokeWidth={1.5} />
        ))}
        <rect x={xOf(stats.p25)} y={mid - 9} width={Math.max(2, xOf(stats.p75) - xOf(stats.p25))} height={18} rx={3} fill="var(--surface-2)" stroke="var(--fg-muted)" />
        <line x1={xOf(stats.p50)} x2={xOf(stats.p50)} y1={mid - 9} y2={mid + 9} stroke="var(--fg)" strokeWidth={2} />
        <path d={`M${xOf(stats.mean)},${mid - 13} l5,-6 h-10 z`} fill="var(--primary)" />
        {Array.from({ length: Math.floor(xMax / 10) + 1 }, (_, i) => i * 10).map((v) => (
          <text key={v} x={xOf(v)} y={height - 6} textAnchor="middle" {...AXIS} className="tabular-nums">
            {v}
          </text>
        ))}
      </svg>
      {hover != null && bins[hover] && (
        <ChartTooltip x={xOf(bins[hover].to)} y={yOf(bins[hover].count)} width={width}>
          <div className="mb-1 font-semibold tabular-nums">{bins[hover].from}–{bins[hover].to} km/h</div>
          <TooltipRow label="Hops" value={fmtInt(bins[hover].count)} swatch="var(--series-2)" />
          <TooltipRow label="Share" value={`${((bins[hover].count / stats.n) * 100).toFixed(1)}%`} />
        </ChartTooltip>
      )}
      <dl className="mt-2 grid grid-cols-3 gap-x-4 gap-y-1 text-xs sm:grid-cols-6">
        {([
          ['P10', stats.p10], ['P25', stats.p25], ['Median', stats.p50], ['Mean', stats.mean], ['P75', stats.p75], ['P90', stats.p90],
        ] as const).map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-2 border-b border-line py-0.5">
            <dt className="flex items-center gap-1 text-fg-muted">
              {k === 'Mean' && <span aria-hidden="true" className="inline-block h-0 w-0 border-x-[4px] border-t-[5px] border-x-transparent border-t-primary" />}
              {k}
            </dt>
            <dd className="font-medium tabular-nums text-fg">{v} km/h</dd>
          </div>
        ))}
      </dl>
      <SrTable caption={`${ariaLabel} (km/h bins)`} headers={['Speed band', 'Hops']} rows={bins.map((b) => [`${b.from}–${b.to} km/h`, b.count])} />
    </div>
  );
}
