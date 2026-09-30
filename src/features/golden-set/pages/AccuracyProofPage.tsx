// ═══════════════════════════════════════════════════
// AccuracyProofPage (/accuracy) — the model's plate-OCR accuracy on the team's
// human-labelled golden set, shown with the real crops: headline vs the PS
// target, a replay of the recorded live-API run, per-condition breakdown,
// every mistake, and the full gallery. All figures come from
// public/golden/results_golden_v1.json (pipeline/tools/upload_golden.py).
// ═══════════════════════════════════════════════════

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BadgeCheckIcon, EyeOffIcon, ScanTextIcon } from 'lucide-react';
import { Page, PageHeader } from '@/shared/layout/Page';
import { ErrorState } from '@/shared/ui/ErrorState';
import { Skeleton, SkeletonPanel } from '@/shared/ui/Skeleton';
import { useGoldenResults } from '../api';
import { fmtInt, type GoldenItem } from '../lib/results';
import { GoldenStyles } from '../components/parts';
import { Hero } from '../components/Hero';
import { LiveReel } from '../components/LiveReel';
import { Breakdown } from '../components/Breakdown';
import { Mistakes } from '../components/Mistakes';
import { Gallery } from '../components/Gallery';
import { ItemDrawer } from '../components/ItemDrawer';

export function AccuracyProofPage() {
  const { data, error, loading, retry } = useGoldenResults();
  const [open, setOpen] = useState<GoldenItem | null>(null);

  return (
    <Page>
      <GoldenStyles />
      <PageHeader
        title="Accuracy Proof"
        icon={BadgeCheckIcon}
        description="Our trained Indian-plate ANPR model, scored plate by plate against the team's human-labelled golden set."
        actions={
          <Link to="/model" className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline">
            <ScanTextIcon size={14} aria-hidden /> Model Performance
          </Link>
        }
      />
      {loading ? (
        <div className="space-y-4" aria-busy="true">
          <div className="rounded-md border border-line bg-surface p-5">
            <Skeleton className="h-4 w-56" />
            <Skeleton className="mt-4 h-[72px] w-72" />
            <Skeleton className="mt-4 h-5 w-96 max-w-full" />
          </div>
          <SkeletonPanel height={360} />
        </div>
      ) : error || !data ? (
        <ErrorState title="Results unavailable" message={error ?? 'No results'} onRetry={retry} />
      ) : (
        <>
          <Hero r={data} onOpen={setOpen} />
          <LiveReel results={data} />
          <Breakdown r={data} />
          <Mistakes r={data} onOpen={setOpen} />
          <section className="flex items-start gap-3 rounded-md border border-line bg-surface p-4 text-xs text-fg-muted" aria-label="Excluded images">
            <EyeOffIcon size={18} className="mt-0.5 shrink-0 text-fg-subtle" aria-hidden />
            <p>
              <span className="font-semibold text-fg">
                {fmtInt(data.unreadable)} of {fmtInt(data.totalImages)} golden images are not scored.
              </span>{' '}
              The human labellers marked them unreadable — heavy motion blur, too small or cut off — so there is no ground truth to compare a
              read against. They are excluded as in the team's labelling protocol; the {fmtInt(data.scored)} readable plates above are all scored,
              with nothing else filtered out.
            </p>
          </section>
          <Gallery r={data} onOpen={setOpen} />
          <ItemDrawer r={data} item={open} onClose={() => setOpen(null)} />
        </>
      )}
    </Page>
  );
}
