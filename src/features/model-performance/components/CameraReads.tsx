// "Camera feed: readable reads": the plate reads on the Mumbai clips that have a
// saved crop, with the model's own confidence (not verified) and, separately,
// the accuracy measured from human verification (never from the confidence).

import { useMemo, useState } from 'react';
import { CameraIcon, ChevronLeftIcon, ChevronRightIcon, ShieldCheckIcon } from 'lucide-react';
import { Panel } from '@/shared/ui/Card';
import { Badge } from '@/shared/ui/Badge';
import { EmptyState } from '@/shared/ui/EmptyState';
import { SkeletonPanel } from '@/shared/ui/Skeleton';
import { IconButton } from '@/shared/ui/Button';
import { cropUrl, fmtClip, type CameraRead, type CameraReadsState } from '../lib/cameraReads';
import { verifiedAccuracy, type Label, type VerifiedFile } from '../lib/verification';
import { CropThumb } from './CropThumb';
import { SCOPE_NOTE } from './GoldenHeadline';

const READS_PAGE_SIZE = 24;

const VERDICT_LABEL = { correct: 'Verified correct', wrong: 'Verified wrong', unreadable: 'Unreadable' } as const;
const VERDICT_TONE = { correct: 'success', wrong: 'danger', unreadable: 'neutral' } as const;

const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Verified accuracy block: only ever shows a number computed from human labels. */
export function VerifiedSummary({ file, keys }: { file: VerifiedFile | null; keys?: ReadonlySet<string> }) {
  const a = file ? verifiedAccuracy(file.labels, keys) : null;
  if (!file || !a || a.n === 0) {
    return (
      <section aria-label="Verified accuracy" className="rounded-md border border-dashed border-line bg-surface-2/40 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="warning" icon={<ShieldCheckIcon />}>Verification pending</Badge>
          <span className="text-xs text-fg-muted">
            No human-verified accuracy is published for the camera feed yet, so none is shown. The confidence on each read is the model's own score and is not an accuracy.
          </span>
        </div>
        {a && a.unreadable > 0 && <p className="mt-1 text-2xs text-fg-subtle">{a.unreadable} reads marked unreadable so far (excluded from accuracy).</p>}
      </section>
    );
  }
  return (
    <section aria-label="Verified accuracy" className="space-y-2 rounded-md border border-line bg-surface-2/40 p-3">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
        <div className="text-4xl font-semibold leading-none tabular-nums text-fg" data-testid="mp-verified-accuracy">
          {(a.accuracy! * 100).toFixed(1)}
          <span className="ml-0.5 text-xl font-medium text-fg-muted">%</span>
        </div>
        <p className="text-sm text-fg-muted">
          human-verified accuracy: <span className="font-semibold tabular-nums text-fg">{a.correct}</span> of{' '}
          <span className="font-semibold tabular-nums text-fg">{a.n}</span> verified camera-feed reads exactly right
        </p>
      </div>
      <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-fg-subtle">95% Wilson interval</dt>
          <dd className="font-medium tabular-nums text-fg" data-testid="mp-verified-ci">{a.ci ? `${pct1(a.ci.low)} to ${pct1(a.ci.high)}` : '—'}</dd>
        </div>
        <div>
          <dt className="text-fg-subtle">Reviewed reads</dt>
          <dd className="font-medium tabular-nums text-fg" data-testid="mp-verified-counts">
            n = {a.n} verified: {a.correct} correct, {a.wrong} wrong · {a.unreadable} unreadable (not scored)
          </dd>
        </div>
        <div>
          <dt className="text-fg-subtle">Verified by · on</dt>
          <dd className="font-medium text-fg">{file.verified_by || 'not stated'} · {file.verified_at || 'date not stated'}</dd>
        </div>
      </dl>
      <p className="text-2xs text-fg-subtle">
        Definition: accuracy = correct / (correct + wrong), judged by a person against the plate crop; exact whole-plate match, no partial credit; reads the person
        marked unreadable are not counted. A small sample: read the interval, not just the percentage.
      </p>
    </section>
  );
}

function ReadCard({ r, label }: { r: CameraRead; label?: Label }) {
  return (
    <li className="flex gap-2 rounded-md border border-line bg-surface p-2" aria-label={`${r.camera} at ${fmtClip(r.timeSec)}: read ${r.text || 'nothing'}`}>
      <div className="flex shrink-0 flex-col gap-1">
        <CropThumb src={cropUrl(r.plateCrop)} alt={`Plate crop, ${r.camera} at ${fmtClip(r.timeSec)}`} className="h-12 w-24" />
        {r.vehicleCrop && <CropThumb src={cropUrl(r.vehicleCrop)} alt={`Vehicle crop, ${r.camera} at ${fmtClip(r.timeSec)}`} className="h-12 w-24" />}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="truncate font-mono text-[15px] font-semibold tracking-wide text-fg" title={r.raw ? 'Raw OCR string (not a valid plate format)' : undefined}>
          {r.text || '—'}
          {r.raw && <span className="ml-1 font-sans text-2xs font-normal text-fg-subtle">raw</span>}
        </div>
        <div className="text-xs tabular-nums text-fg-muted">
          <span className="font-mono text-fg">{r.camera}</span> · clip {fmtClip(r.timeSec)}
        </div>
        <div className="text-xs text-fg-muted">
          <span title="The model's own score; not checked against the true plate">model confidence, not verified</span>:{' '}
          <span className="font-semibold tabular-nums text-fg">{r.confidence == null ? '—' : `${Math.round(r.confidence * 100)}%`}</span>
        </div>
        {label && <Badge size="sm" tone={VERDICT_TONE[label.verdict]}>{VERDICT_LABEL[label.verdict]}{label.verdict === 'wrong' && label.truth ? `: ${label.truth}` : ''}</Badge>}
      </div>
    </li>
  );
}

export function CameraReads({ reads, verified }: { reads: CameraReadsState | null; verified: VerifiedFile | null }) {
  const [page, setPage] = useState(0);
  const rows = useMemo(() => (reads?.status === 'ready' ? reads.rows : []), [reads]);
  const keys = useMemo(() => new Set(rows.map((r) => r.key)), [rows]);
  const pages = Math.max(1, Math.ceil(rows.length / READS_PAGE_SIZE));
  const cur = Math.min(page, pages - 1);
  const shown = rows.slice(cur * READS_PAGE_SIZE, (cur + 1) * READS_PAGE_SIZE);

  const pager = pages > 1 && (
    <div className="flex items-center gap-1">
      <IconButton label="Previous page of reads" size="sm" icon={<ChevronLeftIcon size={16} />} disabled={cur === 0} onClick={() => setPage(cur - 1)} />
      <span className="min-w-[64px] text-center text-xs tabular-nums text-fg-muted">{cur + 1} / {pages}</span>
      <IconButton label="Next page of reads" size="sm" icon={<ChevronRightIcon size={16} />} disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)} />
    </div>
  );

  return (
    <Panel
      title="Camera feed: readable reads"
      subtitle={rows.length ? `${rows.length} reads with a saved crop · Mumbai clips` : 'Mumbai clips'}
      icon={<CameraIcon />}
      actions={pager || undefined}
      footer="Plate text and confidence come from the model's per-vehicle events on the camera clips. Sorted by camera, then model confidence. Accuracy is shown only from human verification."
    >
      {!reads ? (
        <SkeletonPanel height={200} />
      ) : reads.status === 'missing' ? (
        <EmptyState compact title="No camera-feed crops published" description="public/detections/crops/manifest.json is not available, so no reads are listed. Generate the crops locally and try again." />
      ) : (
        <div className="space-y-4">
          <VerifiedSummary file={verified} keys={keys} />
          <p className="text-xs text-fg-muted" data-testid="mp-camera-scope-note">{SCOPE_NOTE}</p>
          <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" aria-label="Camera feed reads">
            {shown.map((r) => (
              <ReadCard key={r.key} r={r} label={verified?.labels[r.key]} />
            ))}
          </ul>
          {reads.unmatched > 0 && <p className="text-2xs text-fg-subtle">{reads.unmatched} saved crops have no matching event and are not listed.</p>}
        </div>
      )}
    </Panel>
  );
}
