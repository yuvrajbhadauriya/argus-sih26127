// Every wrong read, label vs read side by side with the differing characters marked.

import { useMemo } from 'react';
import { TriangleAlertIcon } from 'lucide-react';
import { Panel } from '@/shared/ui/Card';
import { Badge } from '@/shared/ui/Badge';
import { confidenceSplit, conditionLabel, fmtInt, plateVariant, type GoldenItem, type GoldenResults } from '../lib/results';
import { diffMarks } from '../lib/diff';
import { useCropUrls } from '../lib/useCropUrls';
import { CropImage, PlateRead } from './parts';

export function Mistakes({ r, onOpen }: { r: GoldenResults; onOpen: (it: GoldenItem) => void }) {
  const wrong = useMemo(() => r.items.filter((i) => !i.correct), [r.items]);
  const rows = useMemo(() => wrong.map((it) => ({ it, m: diffMarks(it.gt, it.pred) })), [wrong]);
  const oneChar = rows.filter(({ m }) => m.gt.size <= 1 && m.pred.size <= 1).length;
  const split = useMemo(() => confidenceSplit(r.items), [r.items]);
  const urls = useCropUrls(r, wrong);
  if (!wrong.length) return null;
  return (
    <Panel
      id="mistakes"
      title={`All ${fmtInt(wrong.length)} mistakes`}
      subtitle="nothing hidden"
      icon={<TriangleAlertIcon />}
      className="scroll-mt-4"
    >
      <p className="mb-3 text-xs text-fg-muted">
        {fmtInt(oneChar)} of {fmtInt(wrong.length)} wrong reads differ from the label by a single character.
        {split.wrong != null && split.correct != null && (
          <>
            {' '}Their median confidence is <span className="font-semibold tabular-nums text-fg">{split.wrong.toFixed(1)}%</span> vs{' '}
            <span className="font-semibold tabular-nums text-fg">{split.correct.toFixed(1)}%</span> for correct reads — the model usually knows when it is unsure.
          </>
        )}
      </p>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {rows.map(({ it, m }) => {
          const v = plateVariant(it);
          return (
            <li key={it.key}>
              <button
                type="button"
                onClick={() => onOpen(it)}
                className="flex w-full flex-col gap-2 rounded-md border border-line bg-surface p-2.5 text-left transition-colors hover:border-line-strong hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-focus"
                aria-label={`Open plate labelled ${it.gt}, read as ${it.pred}`}
              >
                <CropImage src={urls.url(it)} onBroken={() => urls.broken(it)} width={it.width} height={it.height} alt={`Plate crop labelled ${it.gt}`} className="h-20 w-full rounded-sm" />
                <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5 text-2xs text-fg-subtle">
                  <span>Label</span>
                  <PlateRead text={it.gt} variant={v} size="sm" marks={m.gt} label={`Human label ${it.gt}`} />
                  <span>Read</span>
                  <PlateRead text={it.pred || '—'} variant={v} size="sm" marks={m.pred} label={`Model read ${it.pred}`} />
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <Badge size="sm" tone={it.confidence < 75 ? 'warning' : 'neutral'}>{it.confidence.toFixed(1)}% conf.</Badge>
                  {it.rowCount === 2 && <Badge size="sm">2 rows</Badge>}
                  {it.conditions.filter((c) => c !== 'hsrp-standard').map((c) => (
                    <Badge key={c} size="sm" tone="info">{conditionLabel(c)}</Badge>
                  ))}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
