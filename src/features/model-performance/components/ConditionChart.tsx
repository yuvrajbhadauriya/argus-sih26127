// ═══════════════════════════════════════════════════
// ConditionChart — plate accuracy and character accuracy per capture
// condition, horizontal paired bars on a 0–100% scale with the PS target
// drawn as a reference line. In-house SVG (same helpers as analytics charts).
// ═══════════════════════════════════════════════════

import { useState } from 'react';
import { ChartTooltip, SrTable, TooltipRow } from '@/features/analytics/components/charts/ChartTooltip';
import { barPath, useElementWidth } from '@/features/analytics/components/charts/chartUtils';
import { CONDITION_LABEL, fmtPct, type ConditionRow } from '../lib/results';

const SERIES = [
  { key: 'plate_accuracy', label: 'Plate accuracy', color: 'var(--series-1)' },
  { key: 'char_accuracy', label: 'Character accuracy', color: 'var(--series-2)' },
] as const;

const ROW = 40;
const BAR = 12;
const LABEL_W = 150;
const VALUE_W = 52;

export function ConditionChart({ rows, target }: { rows: ConditionRow[]; target: number }) {
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ i: number; y: number; x: number } | null>(null);
  const plotW = Math.max(60, width - LABEL_W - VALUE_W);
  const top = 18;
  const h = top + rows.length * ROW;
  const xOf = (v: number) => LABEL_W + v * plotW;
  const caption = 'Plate and character accuracy by capture condition';

  return (
    <div ref={ref} className="relative w-full" onMouseLeave={() => setHover(null)}>
      <svg width={width} height={h} role="img" aria-label={caption} className="block overflow-visible">
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <g key={t}>
            <line x1={xOf(t)} x2={xOf(t)} y1={top} y2={h} stroke="var(--line)" strokeDasharray={t === 0 ? undefined : '2 3'} />
            {Math.abs(t - target) > 0.08 && (
              <text x={xOf(t)} y={10} textAnchor="middle" fontSize={11} fill="var(--fg-subtle)" className="tabular-nums">
                {t * 100}%
              </text>
            )}
          </g>
        ))}
        {rows.map((r, i) => {
          const y = top + i * ROW;
          return (
            <g
              key={r.condition}
              opacity={hover && hover.i !== i ? 0.55 : 1}
              onMouseMove={(e) => setHover({ i, y: y + ROW, x: e.nativeEvent.offsetX })}
            >
              <rect x={0} y={y} width={width} height={ROW} fill="transparent" />
              <text x={0} y={y + ROW / 2 - 6} dominantBaseline="central" fontSize={12} fill="var(--fg)" className="font-medium">
                {CONDITION_LABEL[r.condition] ?? r.condition}
              </text>
              <text x={0} y={y + ROW / 2 + 9} dominantBaseline="central" fontSize={10.5} fill="var(--fg-subtle)">
                {r.plates} plates · {r.source}
              </text>
              {SERIES.map((s, k) => {
                const v = r[s.key];
                const by = y + 6 + k * (BAR + 2);
                const w = v == null ? 0 : Math.max(v > 0 ? 2 : 0, v * plotW);
                return (
                  <g key={s.key}>
                    <path d={barPath(LABEL_W, by, w, BAR, true)} style={{ fill: s.color }} />
                    <text x={LABEL_W + w + 6} y={by + BAR / 2} dominantBaseline="central" fontSize={11} fill="var(--fg-muted)" className="tabular-nums">
                      {fmtPct(v)}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}
        <line x1={xOf(target)} x2={xOf(target)} y1={top - 4} y2={h} stroke="var(--fg)" strokeWidth={1.5} strokeDasharray="4 3" />
        <text x={xOf(target)} y={10} textAnchor="middle" fontSize={11} fontWeight={600} fill="var(--fg)">
          Target {Math.round(target * 100)}%
        </text>
      </svg>
      {hover && rows[hover.i] && (
        <ChartTooltip x={hover.x} y={hover.y} width={width}>
          <div className="mb-1 font-semibold">{CONDITION_LABEL[rows[hover.i].condition] ?? rows[hover.i].condition}</div>
          {SERIES.map((s) => (
            <TooltipRow key={s.key} label={s.label} value={fmtPct(rows[hover.i][s.key])} swatch={s.color} />
          ))}
          <TooltipRow label="Detection recall" value={fmtPct(rows[hover.i].detection_recall)} />
          <TooltipRow label="Plates" value={rows[hover.i].plates} />
          <div className="mt-1 text-fg-subtle">{rows[hover.i].source === 'heuristic' ? 'Tag estimated from the image' : rows[hover.i].source === 'label' ? 'Tag from dataset labels' : 'Labels + heuristics'}</div>
        </ChartTooltip>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
        {SERIES.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-2 w-2 rounded-[2px]" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-0 w-4 border-t-[1.5px] border-dashed border-fg" />
          PS target
        </span>
      </div>
      <SrTable
        caption={caption}
        headers={['Condition', 'Plate accuracy', 'Character accuracy', 'Plates', 'Tag source']}
        rows={rows.map((r) => [CONDITION_LABEL[r.condition] ?? r.condition, fmtPct(r.plate_accuracy), fmtPct(r.char_accuracy), r.plates, r.source])}
      />
    </div>
  );
}
