// Headline of the Model Performance page: in-domain plate OCR accuracy on the
// golden set, against the PS target. Every figure is read from the loaded files.

import { Link } from 'react-router-dom';
import { AwardIcon, CircleCheckIcon, CircleXIcon, TargetIcon } from 'lucide-react';
import { Panel } from '@/shared/ui/Card';
import { Badge } from '@/shared/ui/Badge';
import { ErrorState } from '@/shared/ui/ErrorState';
import { SkeletonPanel } from '@/shared/ui/Skeleton';
import { cn } from '@/shared/lib/cn';
import { fmtInt, fmtMeasuredDate, pct, type GoldenResults } from '@/features/golden-set/lib/results';
import { goldenHeadline, targetMargin } from '../lib/goldenHeadline';
import type { EvalResults } from '../lib/results';

/** Scope of every accuracy figure on the page. */
export const SCOPE_NOTE = 'Accuracy is measured on readable plates only (plates the reviewers could read); vehicles whose plate is not legible are not scored.';

export function GoldenHeadline({
  golden,
  target,
  loading,
  error,
  onRetry,
}: {
  golden: GoldenResults | null;
  target: EvalResults['target'] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const title = 'Plate OCR accuracy: in-domain golden set';
  if (loading) return <SkeletonPanel height={200} />;
  if (error || !golden) {
    return (
      <Panel title={title} icon={<AwardIcon />}>
        <ErrorState title="Golden-set results unavailable" message={error ?? 'No results'} onRetry={onRetry} />
      </Panel>
    );
  }
  const h = goldenHeadline(golden);
  const margin = target ? targetMargin(h.accuracy, target.plate_accuracy) : null;
  return (
    <Panel
      title={title}
      icon={<AwardIcon />}
      actions={<Link to="/accuracy" className="text-xs font-medium text-primary hover:underline">Accuracy Proof</Link>}
      footer="Task: plate crop in, plate text out (the OCR stage only). Exact whole-plate match, no partial credit. This is not an end-to-end measurement on camera video."
    >
      <section aria-label="In-domain plate OCR accuracy" className="space-y-3">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
          <div className="text-5xl font-semibold leading-none tracking-[-0.02em] text-fg tabular-nums sm:text-6xl" data-testid="mp-golden-accuracy">
            {pct(h.accuracy)}
            <span className="ml-1 text-2xl font-medium text-fg-muted">%</span>
          </div>
          <p className="max-w-[40ch] pb-1 text-sm text-fg-muted">
            <span className="font-semibold tabular-nums text-fg">{fmtInt(h.correct)}</span> of{' '}
            <span className="font-semibold tabular-nums text-fg">{fmtInt(h.n)}</span> human-labelled Indian number-plate crops read exactly right
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="success" icon={<CircleCheckIcon />}>{fmtInt(h.correct)} correct</Badge>
          <Badge tone={h.wrong ? 'danger' : 'neutral'} icon={<CircleXIcon />}>{fmtInt(h.wrong)} wrong</Badge>
          {margin && target ? (
            <>
              <Badge tone={margin.met ? 'success' : 'danger'} variant="solid" size="md" icon={<TargetIcon />}>
                {margin.met ? 'PS target met' : 'Below PS target'}
              </Badge>
              <span className="text-xs tabular-nums text-fg-muted" data-testid="mp-golden-margin">
                target &gt; {Math.round(target.plate_accuracy * 100)}% · {margin.points >= 0 ? '+' : '−'}
                {Math.abs(margin.points).toFixed(2)} pts {margin.met ? 'above' : 'below'} the target
              </span>
            </>
          ) : (
            <span className="text-xs text-fg-muted">PS target unavailable (evaluation results not loaded)</span>
          )}
        </div>
        {target && <p className="text-xs text-fg-muted">PS target: {target.source}</p>}
        <p className="text-xs text-fg-muted" data-testid="mp-scope-note">{SCOPE_NOTE}</p>
        <dl className={cn('grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2')}>
          <div className="flex justify-between gap-3 sm:block">
            <dt className="text-fg-subtle">Data set · n</dt>
            <dd className="font-medium tabular-nums text-fg">Team golden set ({golden.set}) · n = {fmtInt(h.n)} scored plates</dd>
          </div>
          <div className="flex justify-between gap-3 sm:block">
            <dt className="text-fg-subtle">Excluded</dt>
            <dd className="font-medium tabular-nums text-fg">
              {fmtInt(h.unreadable)} of {fmtInt(h.totalImages)} images marked unreadable by the labellers
            </dd>
          </div>
          <div className="flex justify-between gap-3 sm:block">
            <dt className="text-fg-subtle">Measured on</dt>
            <dd className="font-medium text-fg">{fmtMeasuredDate(h.measuredAt)} · live model API</dd>
          </div>
        </dl>
      </section>
    </Panel>
  );
}
