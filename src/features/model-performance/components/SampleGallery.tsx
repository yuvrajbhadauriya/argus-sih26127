// ═══════════════════════════════════════════════════
// SampleGallery — ground truth vs model read, with character-level diff
// ═══════════════════════════════════════════════════

import { CheckIcon, XIcon } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { Badge } from '@/shared/ui/Badge';
import { CONDITION_LABEL, plateDiff, type SamplePrediction } from '../lib/results';

function DiffText({ gt, pred }: { gt: string; pred: string }) {
  const ops = plateDiff(gt, pred);
  return (
    <span className="font-mono text-[13px] tracking-wide">
      {ops.map((op, i) =>
        op.kind === 'eq' ? (
          <span key={i} className="text-fg">{op.pred}</span>
        ) : op.kind === 'del' ? (
          <span key={i} title={`missing ${op.gt}`} className="rounded-[2px] bg-danger/12 px-px text-danger line-through">{op.gt}</span>
        ) : (
          <span key={i} title={op.kind === 'sub' ? `${op.gt} read as ${op.pred}` : `extra ${op.pred}`} className="rounded-[2px] bg-danger/12 px-px font-semibold text-danger underline">
            {op.pred}
          </span>
        ),
      )}
    </span>
  );
}

export function SampleGallery({ samples }: { samples: SamplePrediction[] }) {
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Sample predictions">
      {samples.map((s, i) => (
        <li key={`${s.id}-${i}`} className="flex gap-3 rounded-md border border-line bg-surface-2/40 p-2.5">
          <div className="flex h-12 w-24 shrink-0 items-center justify-center overflow-hidden rounded-sm border border-line bg-canvas">
            {s.thumb ? (
              <img src={s.thumb} alt={`Plate crop, ground truth ${s.gt}`} loading="lazy" className="max-h-full max-w-full object-contain" />
            ) : (
              <span className="px-1 text-center text-2xs leading-tight text-fg-subtle">image not redistributable</span>
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[13px] tracking-wide text-fg-muted" title="Ground truth">{s.gt}</span>
              <span
                className={cn('inline-flex h-5 w-5 items-center justify-center rounded-full', s.correct ? 'bg-success/12 text-success' : 'bg-danger/12 text-danger')}
                aria-label={s.correct ? 'Correct' : 'Incorrect'}
              >
                {s.correct ? <CheckIcon size={12} /> : <XIcon size={12} />}
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-fg-subtle">
              <span>Read:</span>
              {s.pred ? <DiffText gt={s.gt} pred={s.pred} /> : <span className="italic text-danger">no plate read</span>}
            </div>
            <div className="flex flex-wrap gap-1">
              <Badge size="sm">{s.dataset}</Badge>
              {s.conditions.filter((c) => c !== 'day' && c !== 'sharp').map((c) => (
                <Badge key={c} size="sm" tone="info">{CONDITION_LABEL[c] ?? c}</Badge>
              ))}
              {!s.correct && s.lenient_correct && <Badge size="sm" tone="warning">O/0 or I/1 only</Badge>}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
