// ═══════════════════════════════════════════════════
// ModelPerformancePage — accuracy of the ANPR model, from honest sources:
// 1. headline: in-domain plate OCR accuracy on the golden set
//    (public/golden/results_golden_v1.json) vs the PS target (public/eval/results.json),
// 2. camera feed: the readable reads with a saved crop, and the accuracy
//    measured ONLY from human verification (public/eval/camera_reads_verified.json),
// 3. real reads: actual golden-set crops with the model's OCR text and the ground truth,
// 4. the model card.
// Model architecture / checkpoint names are never rendered (redactModelNames).
// ═══════════════════════════════════════════════════

import { useEffect, useState, type ReactNode } from 'react';
import { CpuIcon, ScanTextIcon } from 'lucide-react';
import { Page, PageHeader } from '@/shared/layout/Page';
import { Panel } from '@/shared/ui/Card';
import { Badge } from '@/shared/ui/Badge';
import { fetchEvalResults } from '../api';
import { fmtPct, type EvalResults } from '../lib/results';
import { GoldenHeadline } from '../components/GoldenHeadline';
import { RealReads } from '../components/RealReads';
import { CameraReads } from '../components/CameraReads';
import { useCameraReads } from '../lib/useCameraReads';
import { Breakdown } from '@/features/golden-set/components/Breakdown';
import { GoldenStyles } from '@/features/golden-set/components/parts';
import { useGoldenResults } from '@/features/golden-set/api';
import { GENERIC_ENGINE_NAME, GENERIC_MODEL_NAME, redactModelNames } from '../lib/publicCopy';

/** public/eval/results.json: the PS target (and the model card). Null while loading or if the file is unavailable. */
function useEval(): EvalResults | null {
  const [results, setResults] = useState<EvalResults | null>(null);
  useEffect(() => {
    let alive = true;
    fetchEvalResults().then(
      (r) => alive && setResults(r),
      () => alive && setResults(null),
    );
    return () => {
      alive = false;
    };
  }, []);
  return results;
}

function ModelCard({ r }: { r: EvalResults }) {
  const card = r.model_card;
  // OCR figures are the headline (golden set); end-to-end figures in the card describe earlier model versions, so only the rest stays here.
  const teamOther = (card?.reported ?? []).filter((b) => b.scope !== 'ocr' && b.scope !== 'end_to_end');
  const rows: [string, ReactNode][] = [
    ['Model', GENERIC_MODEL_NAME],
    // The model API is LAN/VPN-only; its live state is the AI engine status in the top bar (model_status heartbeat).
    ['Live API', <span key="h" className="text-fg-muted">Team GPU network · status in the top bar</span>],
  ];
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-semibold text-fg">{GENERIC_ENGINE_NAME}</span>
          <Badge size="sm">GPU inference</Badge>
        </div>
        <p className="text-xs text-fg-muted">
          <span className="text-fg-subtle">Pipeline · </span>vehicle + plate detection, then Indian-plate text recognition (OCR)
        </p>
        {card?.hardware && <p className="text-xs text-fg-muted"><span className="text-fg-subtle">Hardware · </span>{redactModelNames(card.hardware)}</p>}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-fg-muted">{k}</dt>
            <dd className="min-w-0 truncate text-right font-medium tabular-nums text-fg">{v}</dd>
          </div>
        ))}
      </dl>
      {teamOther.length > 0 && (
        <div className="border-t border-line pt-3">
          <h3 className="mb-1 text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">Reported by the model team</h3>
          <ul className="space-y-1 text-xs" aria-label="Model team benchmarks">
            {teamOther.map((b) => (
              <li key={b.metric} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-fg-muted" title={redactModelNames(b.metric)}>{redactModelNames(b.metric)}</span>
                <span className="shrink-0 font-medium tabular-nums text-fg">{b.value != null ? fmtPct(b.value) : b.value_ms != null ? `${b.value_ms} ms` : '—'}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-2xs text-fg-subtle">Reported by the model team on their own benchmarks; not measured by this harness.</p>
        </div>
      )}
    </div>
  );
}

export function ModelPerformancePage() {
  const r = useEval();
  const golden = useGoldenResults();
  const camera = useCameraReads();

  return (
    <Page>
      <PageHeader
        title="Model Performance"
        icon={ScanTextIcon}
        description="Accuracy of the trained Indian-plate ANPR model: in-domain plate OCR on the team's golden set, the readable plate reads on the camera feeds, and real crop-to-text reads."
      />

      <GoldenStyles />
      <GoldenHeadline golden={golden.data} target={r?.target ?? null} loading={golden.loading} error={golden.error} onRetry={golden.retry} />
      {golden.data && <Breakdown r={golden.data} title="Accuracy by condition: in-domain golden set" subtitle={`${golden.data.set} · light, plate type, layout and side`} />}
      <CameraReads reads={camera.reads} verified={camera.verified} />
      {!golden.loading && <RealReads golden={golden.data} />}
      {r && (
        <Panel title="Model card" icon={<CpuIcon />}>
          <ModelCard r={r} />
        </Panel>
      )}
    </Page>
  );
}
