// Accuracy per capture condition / plate type, real tallies from the file.

import { ChartColumnIcon } from 'lucide-react';
import { Panel } from '@/shared/ui/Card';
import { Badge } from '@/shared/ui/Badge';
import { cn } from '@/shared/lib/cn';
import { BREAKDOWN_GROUPS, fmtInt, otherGroups, PS_TARGET, SMALL_SAMPLE, type GoldenResults } from '../lib/results';

export function Breakdown({ r, title = 'Accuracy by condition', subtitle = 'light, plate type, layout and side' }: { r: GoldenResults; title?: string; subtitle?: string }) {
  const cards = BREAKDOWN_GROUPS.map((g) => ({ ...g, t: r.breakdown[g.key] })).filter((g) => g.t && g.t.n > 0);
  const others = otherGroups(r);
  return (
    <Panel title={title} subtitle={subtitle} icon={<ChartColumnIcon />}>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        {cards.map(({ key, label, hint, t }) => {
          const acc = t.n ? t.correct / t.n : 0;
          const small = t.n < SMALL_SAMPLE;
          return (
            <li key={key} className="rounded-md border border-line bg-surface-2/50 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-semibold text-fg">{label}</div>
                  <div className="truncate text-2xs text-fg-subtle">{hint}</div>
                </div>
                {small && <Badge size="sm" tone="warning" title="Fewer than 30 plates — treat the percentage with care">small sample</Badge>}
              </div>
              <div className="mt-2 flex items-baseline justify-between gap-2">
                <span className={cn('text-2xl font-semibold tabular-nums', acc > PS_TARGET ? 'text-fg' : 'text-danger')}>{(acc * 100).toFixed(1)}%</span>
                <span className="text-xs tabular-nums text-fg-muted">
                  {fmtInt(t.correct)} / {fmtInt(t.n)}
                </span>
              </div>
              <div className="relative mt-2 h-1.5 rounded-full bg-surface-3" aria-hidden>
                <div className={cn('h-full rounded-full', acc > PS_TARGET ? 'bg-success' : 'bg-danger')} style={{ width: `${acc * 100}%` }} />
                <div className="absolute -top-0.5 h-2.5 w-px bg-fg-muted" style={{ left: `${PS_TARGET * 100}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
      {others.length > 0 && (
        <p className="mt-3 text-xs text-fg-muted">
          Also in the set, too few to rate:{' '}
          {others.map((o, i) => (
            <span key={o.key}>
              {i > 0 && ' · '}
              {o.label} <span className="tabular-nums text-fg">{o.correct}/{o.n}</span>
            </span>
          ))}
          . The tick on each bar marks the 90% target.
        </p>
      )}
    </Panel>
  );
}
