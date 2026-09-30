// ═══════════════════════════════════════════════════
// ModelPerformancePage — accuracy of the ANPR model, from three honest sources:
// 1. the model team's own plate-OCR benchmarks (labelled as such),
// 2. what this dashboard's harness measured end-to-end (pipeline/eval →
//    public/eval/results.json; sample/mock runs get a banner, no verdict),
// 3. the high-confidence read rate on the 8 Mumbai clips, computed from the
//    real per-vehicle event files (public/detections/events_<code>.json).
// Model architecture / checkpoint names are never rendered (redactModelNames).
// ═══════════════════════════════════════════════════

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  CpuIcon,
  FlaskConicalIcon,
  GaugeIcon,
  ScanTextIcon,
  TargetIcon,
  TimerIcon,
  TriangleAlertIcon,
  TypeIcon,
  VideoIcon,
  AwardIcon,
  ScanLineIcon,
} from 'lucide-react';
import { Page, PageHeader } from '@/shared/layout/Page';
import { Panel } from '@/shared/ui/Card';
import { KpiStrip, KpiTile } from '@/shared/ui/KpiTile';
import { Badge } from '@/shared/ui/Badge';
import { DataTable, type Column } from '@/shared/ui/DataTable';
import { EmptyState } from '@/shared/ui/EmptyState';
import { ErrorState } from '@/shared/ui/ErrorState';
import { SkeletonPanel } from '@/shared/ui/Skeleton';
import { fetchEvalResults, fetchModelHealth, fetchVideoConsistency, type ModelHealth } from '../api';
import { fmtMs, fmtPct, verdict, type DatasetRow, type EvalResults, type Verdict, type VideoCamera, type VideoConsistency } from '../lib/results';
import { ConditionChart } from '../components/ConditionChart';
import { SampleGallery } from '../components/SampleGallery';
import { fetchAllCameraEvents } from '@/features/detections/api';
import {
  GENERIC_ENGINE_NAME,
  GOOD_READ_CONFIDENCE,
  GENERIC_MODEL_NAME,
  HIGH_CONFIDENCE,
  TEAM_BENCHMARKS,
  readRateStats,
  redactModelNames,
  type ReadRateRow,
  type ReadRateStats,
} from '../lib/publicCopy';

/** High-confidence read rate from the real clip event files (null while loading / unavailable). */
function useReadRates(): { stats: ReadRateStats | null; loading: boolean } {
  const [state, setState] = useState<{ stats: ReadRateStats | null; loading: boolean }>({ stats: null, loading: true });
  useEffect(() => {
    let alive = true;
    fetchAllCameraEvents()
      .then((cams) => alive && setState({ stats: cams.length ? readRateStats(cams) : null, loading: false }))
      .catch(() => alive && setState({ stats: null, loading: false }));
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

interface State {
  results: EvalResults | null;
  video: VideoConsistency | null;
  health: ModelHealth | null;
  error: string | null;
  loading: boolean;
}

function useEval() {
  const [state, setState] = useState<State>({ results: null, video: null, health: null, error: null, loading: true });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    Promise.all([fetchEvalResults().then((r) => ({ r, e: null }), (e: unknown) => ({ r: null, e })), fetchVideoConsistency(), fetchModelHealth()]).then(
      ([{ r, e }, video, health]) => {
        if (!alive) return;
        setState({
          results: r,
          video,
          health,
          error: e ? (e instanceof Error ? e.message : 'Failed to load evaluation results') : null,
          loading: false,
        });
      },
    );
    return () => {
      alive = false;
    };
  }, [nonce]);
  return { ...state, retry: useCallback(() => setNonce((n) => n + 1), []) };
}

const VERDICT: Record<Verdict, { label: string; tone: 'success' | 'danger' | 'neutral'; icon: ReactNode }> = {
  pass: { label: 'Meets target', tone: 'success', icon: <CircleCheckIcon /> },
  fail: { label: 'Below target', tone: 'danger', icon: <CircleXIcon /> },
  'not-measured': { label: 'Not measured', tone: 'neutral', icon: <CircleDashedIcon /> },
};

function SampleBanner({ note }: { note: string }) {
  return (
    <div role="status" className="flex items-start gap-3 rounded-md border border-warning/50 bg-warning/10 p-3 text-[13px]">
      <FlaskConicalIcon size={18} className="mt-0.5 shrink-0 text-warning" aria-hidden />
      <div className="min-w-0 space-y-1">
        <div className="font-semibold text-fg">Sample data — run the evaluation</div>
        <p className="text-xs text-fg-muted">
          These numbers come from an offline mock of the model API and say nothing about the trained model
          {note ? ` (${redactModelNames(note)})` : ''}. Plug in the GPU API and run{' '}
          <code className="rounded-sm bg-surface-2 px-1 py-0.5 font-mono text-2xs text-fg">python pipeline/eval/evaluate.py --datasets datacluster hf-plate-crops --workers 2</code>
          {' '}— see <span className="font-mono text-2xs">pipeline/eval/README.md</span>.
        </p>
      </div>
    </div>
  );
}

function TargetMarker({ v, target, accuracy }: { v: Verdict; target: number; accuracy: number | null }) {
  const meta = VERDICT[v];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge tone={meta.tone} variant={v === 'not-measured' ? 'outline' : 'solid'} size="md" icon={meta.icon}>
        {meta.label}
      </Badge>
      <span className="text-xs text-fg-muted">
        target &gt; {Math.round(target * 100)}%
        {v !== 'not-measured' && accuracy != null && ` · ${accuracy >= target ? '+' : ''}${((accuracy - target) * 100).toFixed(1)} pts`}
      </span>
    </div>
  );
}

const datasetColumns: Column<DatasetRow>[] = [
  {
    key: 'name',
    header: 'Dataset',
    cell: (d) => (
      <div className="min-w-0">
        {d.source_url.startsWith('http') ? (
          <a href={d.source_url} target="_blank" rel="noreferrer" className="font-medium text-fg hover:text-primary hover:underline">{d.name}</a>
        ) : (
          <span className="font-medium text-fg">{d.name}</span>
        )}
        <div className="truncate text-2xs text-fg-subtle">{d.license} · {d.kind === 'crop' ? 'plate crops' : 'full scenes'}</div>
      </div>
    ),
    sortValue: (d) => d.name,
  },
  { key: 'plates', header: 'Plates', align: 'right', cell: (d) => d.plates.toLocaleString('en-IN'), sortValue: (d) => d.plates },
  { key: 'acc', header: 'Plate acc.', align: 'right', cell: (d) => fmtPct(d.plate_accuracy), sortValue: (d) => d.plate_accuracy ?? -1 },
  { key: 'len', header: 'Lenient', align: 'right', hideBelow: 'md', cell: (d) => fmtPct(d.lenient_accuracy), sortValue: (d) => d.lenient_accuracy ?? -1 },
  { key: 'char', header: 'Char acc.', align: 'right', cell: (d) => fmtPct(d.char_accuracy), sortValue: (d) => d.char_accuracy ?? -1 },
  { key: 'recall', header: 'Recall', align: 'right', hideBelow: 'sm', cell: (d) => fmtPct(d.detection_recall), sortValue: (d) => d.detection_recall ?? -1 },
  { key: 'p95', header: 'p95 ms', align: 'right', hideBelow: 'md', cell: (d) => fmtMs(d.latency_ms.p95), sortValue: (d) => d.latency_ms.p95 ?? -1 },
];

const videoColumns: Column<VideoCamera>[] = [
  { key: 'cam', header: 'Camera', cell: (c) => <span><span className="font-mono text-xs text-fg">{c.camera_code}</span> <span className="text-fg-muted">{c.camera_name}</span></span> },
  { key: 'frames', header: 'Frames', align: 'right', hideBelow: 'sm', cell: (c) => c.frames },
  { key: 'tracks', header: 'Tracks scored', align: 'right', cell: (c) => `${c.tracks_scored}/${c.tracks_total}` },
  { key: 'stab', header: 'Read stability', align: 'right', cell: (c) => fmtPct(c.mean_stability), sortValue: (c) => c.mean_stability ?? -1 },
  { key: 'stable', header: 'Stable tracks', align: 'right', hideBelow: 'md', cell: (c) => fmtPct(c.stable_track_share, 0) },
];

function ModelCard({ r, health }: { r: EvalResults; health: ModelHealth | null }) {
  const card = r.model_card;
  // OCR figures are shown in the team-benchmark panel; end-to-end figures in
  // the card describe earlier model versions, so only the rest stays here.
  const teamOther = (card?.reported ?? []).filter((b) => b.scope !== 'ocr' && b.scope !== 'end_to_end');
  const rows: [string, ReactNode][] = [
    ['Model', GENERIC_MODEL_NAME],
    ['Evaluated against', r.model.api === 'mock' ? 'Offline mock (noisy oracle)' : 'Live ANPR API (GPU)'],
    ['Evaluated', r.generated_at ? new Date(r.generated_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—'],
    ['Images · plates', `${r.overall.images.toLocaleString('en-IN')} · ${r.overall.plates.toLocaleString('en-IN')}`],
    ['API errors', r.overall.api_errors],
    ['Model inference p50', r.overall.inference_ms.p50 == null ? '—' : `${fmtMs(r.overall.inference_ms.p50)} ms`],
    [
      'Live API',
      health == null ? (
        <span key="h" className="text-fg-subtle">health endpoint unavailable</span>
      ) : !health.configured ? (
        <Badge key="h" tone="warning">not configured</Badge>
      ) : health.reachable ? (
        <Badge key="h" tone="success">reachable{health.latency_ms != null ? ` · ${health.latency_ms} ms` : ''}</Badge>
      ) : (
        <Badge key="h" tone="danger">unreachable</Badge>
      ),
    ],
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
  const { results: r, video, health, error, loading, retry } = useEval();
  const rates = useReadRates();
  const v = r ? verdict(r) : 'not-measured';
  const sample = r?.status !== 'measured';

  return (
    <Page>
      <PageHeader
        title="Model Performance"
        icon={ScanTextIcon}
        description="Accuracy of the trained Indian-plate ANPR model: the model team's OCR benchmarks, this dashboard's own end-to-end measurement, and read confidence on the Mumbai camera clips."
        meta={r && (sample ? <Badge tone="warning" variant="solid">Sample data</Badge> : <Badge tone="info">Measured</Badge>)}
      />

      <TeamBenchmarkPanel />
      <ReadRatePanel stats={rates.stats} loading={rates.loading} />

      {error ? (
        <Panel>
          <ErrorState message={error} onRetry={retry} title="Evaluation results unavailable" />
        </Panel>
      ) : loading || !r ? (
        <SkeletonPanel height={320} />
      ) : (
        <>
          {sample && <SampleBanner note={r.note} />}

          <div className="space-y-1">
            <h2 className="text-[13px] font-semibold text-fg">Out-of-distribution stress test — public internet plate images</h2>
            <p className="text-xs text-fg-muted">
              Full image in, plate text out (detection + OCR), measured by this dashboard's harness on public phone photos and
              plate crops scraped from the internet — a deliberately different domain from the CCTV-style data the model was
              trained for (BEL PS SIH26127 target &gt; 90% refers to in-domain plates). End-to-end accuracy on the camera video
              has not been measured yet.
            </p>
          </div>

          <KpiStrip cols={4}>
            <KpiTile
              label="Stress-test plate accuracy"
              icon={<TargetIcon />}
              tone={v === 'pass' ? 'success' : v === 'fail' ? 'danger' : 'default'}
              value={fmtPct(r.overall.plate_accuracy)}
              hint={<TargetMarker v={v} target={r.target.plate_accuracy} accuracy={r.overall.plate_accuracy} />}
              className={sample ? 'border-dashed' : undefined}
            />
            <KpiTile
              label="Character accuracy"
              icon={<TypeIcon />}
              value={fmtPct(r.overall.char_accuracy)}
              hint={`1 − CER · lenient plate acc. ${fmtPct(r.overall.lenient_accuracy)}`}
              className={sample ? 'border-dashed' : undefined}
            />
            <KpiTile
              label="Plate detection recall"
              icon={<GaugeIcon />}
              value={fmtPct(r.overall.detection_recall)}
              hint={`miss rate ${fmtPct(r.overall.plate_miss_rate)} · OCR acc. on found plates ${fmtPct(r.overall.ocr_accuracy)}`}
              className={sample ? 'border-dashed' : undefined}
            />
            <KpiTile
              label="Latency p95"
              icon={<TimerIcon />}
              value={fmtMs(r.overall.latency_ms.p95)}
              unit="ms"
              hint={`p50 ${fmtMs(r.overall.latency_ms.p50)} ms · round trip per image`}
              className={sample ? 'border-dashed' : undefined}
            />
          </KpiStrip>

          <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <Panel title="Accuracy by condition" subtitle="lighting, weather, blur, angle, plate state" icon={<TriangleAlertIcon />}>
              {r.per_condition.length ? (
                <ConditionChart rows={r.per_condition} target={r.target.plate_accuracy} />
              ) : (
                <EmptyState compact title="No condition tags" description="Add a conditions column to labels.csv, or install opencv-python / Pillow for the image heuristics." />
              )}
              <p className="mt-3 text-2xs text-fg-subtle">
                <span className="font-semibold">label</span> = tagged by the dataset · <span className="font-semibold">heuristic</span> = estimated
                from the image (mean luma → night, Laplacian variance → blur, plate height → low resolution); approximate.
              </p>
            </Panel>
            <Panel title="Model card" icon={<CpuIcon />}>
              <ModelCard r={r} health={health} />
              {r.confusions.length > 0 && (
                <div className="mt-4 border-t border-line pt-3">
                  <h3 className="mb-2 text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">Most common character errors</h3>
                  <ul className="flex flex-wrap gap-1.5" aria-label="Most common character errors">
                    {r.confusions.slice(0, 8).map((c) => (
                      <li key={`${c.gt}>${c.pred}`} className="inline-flex items-center gap-1 rounded-sm border border-line px-1.5 py-0.5 font-mono text-xs">
                        <span className="text-fg">{c.gt || '∅'}</span>
                        <span className="text-fg-subtle">→</span>
                        <span className="text-danger">{c.pred || '∅'}</span>
                        <span className="ml-1 font-sans text-2xs text-fg-subtle">×{c.count}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Panel>
          </div>

          <Panel title="Per dataset" flush footer={r.skipped.length ? `Not evaluated: ${r.skipped.map((s) => s.id).join(', ')} — see pipeline/eval/README.md` : undefined}>
            <DataTable columns={datasetColumns} rows={r.per_dataset} rowKey={(d) => d.id} caption="Accuracy per dataset" />
          </Panel>

          {r.samples.length > 0 && (
            <Panel title="Sample predictions" subtitle="errors first · red = misread character">
              <SampleGallery samples={r.samples} />
            </Panel>
          )}

          <Panel
            title="Video read stability"
            subtitle="Mumbai camera clips · label-free proxy"
            icon={<VideoIcon />}
            flush={Boolean(video)}
            actions={video && (video.status === 'measured' ? <Badge tone="info">Measured</Badge> : <Badge tone="warning">Sample</Badge>)}
            footer={video ? `Share of a tracked vehicle's frames that agree with its majority plate read. A consistently wrong reader also scores high — read next to the labelled accuracy, never instead of it. Stable = ≥ ${Math.round(video.stable_at * 100)}%.` : undefined}
          >
            {video ? (
              <>
                <div className="grid grid-cols-3 gap-3 border-b border-line p-4 text-[13px]">
                  <div><div className="text-2xs uppercase tracking-[0.06em] text-fg-subtle">Mean stability</div><div className="text-lg font-semibold tabular-nums">{fmtPct(video.overall.mean_stability)}</div></div>
                  <div><div className="text-2xs uppercase tracking-[0.06em] text-fg-subtle">Stable tracks</div><div className="text-lg font-semibold tabular-nums">{fmtPct(video.overall.stable_track_share, 0)}</div></div>
                  <div><div className="text-2xs uppercase tracking-[0.06em] text-fg-subtle">Tracks scored</div><div className="text-lg font-semibold tabular-nums">{video.overall.tracks_scored}</div></div>
                </div>
                <DataTable columns={videoColumns} rows={video.per_camera} rowKey={(c) => c.camera_code} caption="Read stability per camera" />
              </>
            ) : (
              <EmptyState compact title="No video run yet" description={<>Run <code className="font-mono">python pipeline/eval/video_consistency.py</code> to measure per-track plate stability on the camera clips.</>} />
            )}
          </Panel>
        </>
      )}
    </Page>
  );
}

function TeamBenchmarkPanel() {
  const headline = TEAM_BENCHMARKS.find((b) => b.headline) ?? TEAM_BENCHMARKS[0];
  const rest = TEAM_BENCHMARKS.filter((b) => b !== headline);
  return (
    <Panel
      title="Plate OCR accuracy (team golden set, measured)"
      icon={<AwardIcon />}
      actions={<Link to="/accuracy" className="text-xs font-medium text-primary hover:underline">Details</Link>}
      footer="Plate crop in, plate text out — the OCR stage only. The golden set was measured through the live OCR endpoint (see Details); the benchmark and two-row figures are the model team's own reported numbers."
    >
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] sm:items-center">
        <div>
          <div className="text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">{headline.label}</div>
          <Link to="/accuracy" className="block text-3xl font-semibold tabular-nums text-success hover:underline">{fmtPct(headline.accuracy, 2)}</Link>
          <div className="text-xs text-fg-muted">
            {headline.correct != null && headline.plates != null
              ? `${headline.correct.toLocaleString('en-IN')} / ${headline.plates.toLocaleString('en-IN')} plates exactly right`
              : 'exact plate match'}
            {' · live OCR endpoint'}
          </div>
        </div>
        <ul className="divide-y divide-line text-[13px]" aria-label="Team OCR benchmarks">
          {rest.map((b) => (
            <li key={b.id} className="flex items-baseline justify-between gap-3 py-1.5">
              <span className="min-w-0 text-fg-muted">
                {b.label}
                {b.plates != null && <span className="text-fg-subtle"> · {b.plates.toLocaleString('en-IN')} plates</span>}
              </span>
              <span className="shrink-0 font-semibold tabular-nums text-fg">{fmtPct(b.accuracy)}</span>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

const readRateColumns: Column<ReadRateRow>[] = [
  { key: 'cam', header: 'Camera', cell: (r) => <span className="font-mono text-xs text-fg">{r.camera_code}</span>, sortValue: (r) => r.camera_code },
  { key: 'veh', header: 'Vehicles', align: 'right', hideBelow: 'sm', cell: (r) => r.vehicles, sortValue: (r) => r.vehicles },
  { key: 'reads', header: 'Plates read', align: 'right', cell: (r) => r.plate_reads, sortValue: (r) => r.plate_reads },
  { key: 'good', header: 'Good reads', align: 'right', hideBelow: 'sm', cell: (r) => r.good_reads, sortValue: (r) => r.good_reads },
  { key: 'high', header: '≥ 80%', align: 'right', cell: (r) => r.high_confidence, sortValue: (r) => r.high_confidence },
  { key: 'rate', header: 'Rate', align: 'right', cell: (r) => fmtPct(r.rate, 0), sortValue: (r) => r.rate ?? -1 },
];

function ReadRatePanel({ stats, loading }: { stats: ReadRateStats | null; loading: boolean }) {
  const pct = Math.round(HIGH_CONFIDENCE * 100);
  const o = stats?.overall;
  return (
    <Panel
      title="High-confidence read rate"
      subtitle="Mumbai clips"
      icon={<ScanLineIcon />}
      flush={Boolean(stats)}
      footer={`High-confidence read rate = plate reads with OCR confidence ≥ ${pct}% ÷ vehicles whose plate was read at all (one read per tracked vehicle). Confidence is the model's own score, not verified against ground truth.`}
    >
      {loading ? (
        <SkeletonPanel height={120} />
      ) : !stats || !o ? (
        <EmptyState compact title="No clip reads published" description="The per-vehicle event files (public/detections/events_<code>.json) are not available." />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3 border-b border-line p-4 text-[13px]">
            <div>
              <div className="text-2xs uppercase tracking-[0.06em] text-fg-subtle">Read rate ≥ {pct}%</div>
              <div className="text-lg font-semibold tabular-nums">{fmtPct(o.rate, 0)}</div>
            </div>
            <div>
              <div className="text-2xs uppercase tracking-[0.06em] text-fg-subtle">Reads ≥ {pct}% / read</div>
              <div className="text-lg font-semibold tabular-nums">{o.high_confidence} / {o.plate_reads}</div>
            </div>
            <div>
              <div className="text-2xs uppercase tracking-[0.06em] text-fg-subtle">Vehicles</div>
              <div className="text-lg font-semibold tabular-nums">{o.vehicles.toLocaleString('en-IN')}</div>
            </div>
          </div>
          <p className="border-b border-line px-4 py-2 text-xs text-fg-muted">
            <span className="font-semibold text-fg">Good read rate: {fmtPct(o.good_rate, 1)}</span> ({o.good_reads} of {o.vehicles} vehicles) —
            good read = OCR confidence ≥ {Math.round(GOOD_READ_CONFIDENCE * 100)}% and a valid Indian plate format.{' '}
            Most vehicles in these overhead clips show no legible plate. Of the {o.valid_format} reads in a valid Indian plate format,{' '}
            <span className="font-semibold tabular-nums text-fg">{o.valid_high}</span> ({fmtPct(o.valid_format ? o.valid_high / o.valid_format : null, 0)}) are ≥ {pct}% confidence.
          </p>
          <DataTable columns={readRateColumns} rows={stats.per_camera} rowKey={(r) => r.camera_code} caption="High-confidence read rate per camera" />
        </>
      )}
    </Panel>
  );
}
