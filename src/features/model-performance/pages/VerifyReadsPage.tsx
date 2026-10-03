// ═══════════════════════════════════════════════════
// VerifyReadsPage (/verify-reads) — DEV ONLY (registered in routes.ts only when
// import.meta.env.DEV; absent from production builds and the navigation).
// A person looks at each camera-feed plate crop and marks the model's read
// Correct / Wrong (+ true plate) / Unreadable. Progress lives in localStorage;
// "Download" writes public/eval/camera_reads_verified.json in the exact format
// the Model Performance page reads.
// ═══════════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState } from 'react';
import { DownloadIcon } from 'lucide-react';
import { Page, PageHeader } from '@/shared/layout/Page';
import { Button } from '@/shared/ui/Button';
import { EmptyState } from '@/shared/ui/EmptyState';
import { SkeletonPanel } from '@/shared/ui/Skeleton';
import { CropThumb } from '../components/CropThumb';
import { cropUrl, fmtClip, loadCameraReads, type CameraReadsState } from '../lib/cameraReads';
import { buildVerifiedFile, verifiedAccuracy, type Label } from '../lib/verification';

export const VERIFY_STORAGE_KEY = 'argus.verifyReads.v1';

interface Saved {
  labels: Record<string, Label>;
  index: number;
  verifiedBy: string;
}

function load(): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(VERIFY_STORAGE_KEY) ?? 'null') as Partial<Saved> | null;
    return { labels: raw?.labels ?? {}, index: raw?.index ?? 0, verifiedBy: raw?.verifiedBy ?? '' };
  } catch {
    return { labels: {}, index: 0, verifiedBy: '' };
  }
}

function download(file: object) {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(file, null, 2)}\n`], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'camera_reads_verified.json';
  a.click();
  URL.revokeObjectURL(url);
}

export function VerifyReadsPage() {
  const [state, setState] = useState<CameraReadsState | null>(null);
  const [saved, setSaved] = useState<Saved>(load);
  const [draft, setDraft] = useState<{ key: string; text: string } | null>(null);
  const truthRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    loadCameraReads().then((s) => alive && setState(s));
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(VERIFY_STORAGE_KEY, JSON.stringify(saved));
    } catch {
      /* storage unavailable: progress is kept for this tab only */
    }
  }, [saved]);

  const rows = state?.status === 'ready' ? state.rows : [];
  const index = Math.min(Math.max(saved.index, 0), Math.max(rows.length - 1, 0));
  const row = rows[index];
  const current = row ? saved.labels[row.key] : undefined;

  // the true-plate input is tied to the read it was typed for
  const truth = draft && draft.key === row?.key ? draft.text : (current?.truth ?? '');
  const setTruth = (text: string) => setDraft({ key: row?.key ?? '', text });

  const go = useCallback((delta: number) => setSaved((s) => ({ ...s, index: Math.min(Math.max(index + delta, 0), Math.max(rows.length - 1, 0)) })), [index, rows.length]);
  const mark = useCallback(
    (verdict: Label['verdict'], truthText?: string) => {
      if (!row) return;
      const t = truthText?.trim().toUpperCase().replace(/\s+/g, '');
      setSaved((s) => ({ ...s, labels: { ...s.labels, [row.key]: { verdict, ...(verdict === 'wrong' && t ? { truth: t } : {}) } }, index: Math.min(index + 1, rows.length - 1) }));
    },
    [row, index, rows.length],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const typing = (e.target as HTMLElement | null)?.tagName === 'INPUT';
      if (typing) return; // the true-plate input handles Enter / Escape itself
      const k = e.key.toLowerCase();
      if (k === 'c') mark('correct');
      else if (k === 'u') mark('unreadable');
      else if (k === 'w') {
        e.preventDefault();
        truthRef.current?.focus();
      } else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else return;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mark, go]);

  const done = rows.filter((r) => saved.labels[r.key]).length;
  const acc = verifiedAccuracy(saved.labels, new Set(rows.map((r) => r.key)));

  return (
    <Page>
      <PageHeader
        title="Verify camera-feed reads"
        description="Dev tool. Judge each read against its plate crop: exact whole-plate match. Then download the file and save it as public/eval/camera_reads_verified.json."
      />
      {!state ? (
        <SkeletonPanel height={240} />
      ) : state.status === 'missing' || !row ? (
        <EmptyState title="No crops to verify" description="public/detections/crops/manifest.json is missing or empty." />
      ) : (
        <div className="mx-auto max-w-3xl space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="font-semibold tabular-nums text-fg" aria-live="polite">
              Read {index + 1} of {rows.length} · {done} verified
            </span>
            <span className="text-xs tabular-nums text-fg-muted">
              {acc.correct} correct · {acc.wrong} wrong · {acc.unreadable} unreadable
            </span>
          </div>
          <div className="rounded-md border border-line bg-surface p-4">
            <div className="flex flex-col gap-4 sm:flex-row">
              <CropThumb src={cropUrl(row.plateCrop)} alt={`Plate crop ${index + 1}`} className="h-40 w-full sm:w-72" />
              {row.vehicleCrop && <CropThumb src={cropUrl(row.vehicleCrop)} alt={`Vehicle crop ${index + 1}`} className="h-40 w-full sm:w-48" />}
            </div>
            <div className="mt-3 text-xs text-fg-muted">
              {row.camera} · clip {fmtClip(row.timeSec)} · model confidence {row.confidence == null ? '—' : `${Math.round(row.confidence * 100)}%`} (not verified)
            </div>
            <div className="mt-1 font-mono text-3xl font-semibold tracking-wider text-fg" data-testid="verify-read">{row.text || '—'}</div>
            {current && <div className="mt-1 text-xs font-semibold text-fg-muted" aria-live="polite">Marked: {current.verdict}{current.truth ? ` (true plate ${current.truth})` : ''}</div>}
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Button className="h-14 text-base" onClick={() => mark('correct')} aria-keyshortcuts="C">Correct (C)</Button>
            <Button className="h-14 text-base" variant="secondary" onClick={() => mark('wrong', truth)} aria-keyshortcuts="W">Wrong (W)</Button>
            <Button className="h-14 text-base" variant="secondary" onClick={() => mark('unreadable')} aria-keyshortcuts="U">Unreadable (U)</Button>
          </div>
          <label className="block text-xs text-fg-muted">
            True plate (optional, for Wrong). Press W to focus, Enter to save as wrong, Esc to leave.
            <input
              ref={truthRef}
              value={truth}
              onChange={(e) => setTruth(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') mark('wrong', truth);
                else if (e.key === 'Escape') truthRef.current?.blur();
              }}
              className="mt-1 block h-10 w-full rounded-md border border-line bg-surface px-3 font-mono text-base uppercase text-fg"
              placeholder="e.g. MH12AB1234"
            />
          </label>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => go(-1)} disabled={index === 0}>Previous (←)</Button>
              <Button variant="ghost" onClick={() => go(1)} disabled={index >= rows.length - 1}>Next (→)</Button>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-xs text-fg-muted">
                Verified by
                <input
                  value={saved.verifiedBy}
                  onChange={(e) => setSaved((s) => ({ ...s, verifiedBy: e.target.value }))}
                  className="mt-1 block h-9 w-44 rounded-md border border-line bg-surface px-2 text-sm text-fg"
                />
              </label>
              <Button icon={<DownloadIcon size={14} />} onClick={() => download(buildVerifiedFile(saved.labels, saved.verifiedBy.trim(), new Date().toISOString()))} disabled={done === 0}>
                Download camera_reads_verified.json
              </Button>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}
