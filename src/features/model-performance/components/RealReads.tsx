// "Real reads: crop -> OCR": actual plate crops with the model's read, the
// ground truth, confidence and a correct/wrong mark. (i) a seeded, unfiltered
// sample of the in-domain golden set; (ii) the out-of-domain stress-test samples.

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ScanSearchIcon } from 'lucide-react';
import { Panel } from '@/shared/ui/Card';
import { EmptyState } from '@/shared/ui/EmptyState';
import { Tile } from '@/features/golden-set/components/Gallery';
import { ItemDrawer } from '@/features/golden-set/components/ItemDrawer';
import { fmtInt, type GoldenItem, type GoldenResults } from '@/features/golden-set/lib/results';
import { useCropUrls } from '@/features/golden-set/lib/useCropUrls';
import { REAL_READS_COUNT, sampleGoldenItems } from '../lib/goldenHeadline';

function GoldenSample({ golden }: { golden: GoldenResults }) {
  const [open, setOpen] = useState<GoldenItem | null>(null);
  const sample = useMemo(() => sampleGoldenItems(golden.items, golden.setHash || golden.set), [golden]);
  const urls = useCropUrls(golden, sample);
  const wrongShown = sample.filter((i) => !i.correct).length;
  const wrongAll = golden.items.filter((i) => !i.correct).length;
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-[13px] font-semibold text-fg">In-domain: {sample.length} plates drawn at random from the golden set</h3>
        <p className="text-xs text-fg-muted">
          A fixed random sample (same plates on every visit), not picked by result: {fmtInt(wrongShown)} of these {fmtInt(sample.length)} are wrong, against{' '}
          {fmtInt(wrongAll)} of {fmtInt(golden.items.length)} wrong in the whole set. Tap a plate for detail.{' '}
          <Link to="/accuracy" className="font-medium text-primary hover:underline touch:inline-block touch:py-2.5 touch:-my-2.5">See every plate and every mistake on Accuracy Proof</Link>.
        </p>
      </div>
      {sample.length ? (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6" aria-label="Golden-set sample reads">
          {sample.map((it) => (
            <Tile key={it.key} it={it} urls={urls} onOpen={setOpen} showTruth />
          ))}
        </ul>
      ) : (
        <EmptyState compact title="No plates to show" />
      )}
      <ItemDrawer r={golden} item={open} onClose={() => setOpen(null)} />
    </div>
  );
}

export function RealReads({ golden }: { golden: GoldenResults | null }) {
  return (
    <Panel title="Real reads: crop → OCR" subtitle={`${REAL_READS_COUNT} random golden-set plates`} icon={<ScanSearchIcon />}>
      {golden ? (
        <GoldenSample golden={golden} />
      ) : (
        <EmptyState compact title="Golden-set crops unavailable" description="The golden-set results file could not be loaded, so no in-domain reads are shown." />
      )}
    </Panel>
  );
}
