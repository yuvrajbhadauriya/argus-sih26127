// Headline: overall accuracy vs the PS target, provenance, and a one-square-
// per-plate map of the whole scored set (red = wrong; click opens the plate).

import type { MouseEvent } from 'react';
import { CircleCheckIcon, CircleXIcon, InfoIcon, ShieldCheckIcon, TimerIcon, CalendarClockIcon, FingerprintIcon, TargetIcon } from 'lucide-react';
import { Badge } from '@/shared/ui/Badge';
import { Popover } from '@/shared/ui/Popover';
import { cn } from '@/shared/lib/cn';
import {
  endpointPath,
  fmtInt,
  fmtMeasuredAt,
  minLabelers,
  pct,
  PS_TARGET,
  shortHash,
  type GoldenItem,
  type GoldenResults,
} from '../lib/results';

const COLS = 100;

function PlateMap({ items, onOpen }: { items: GoldenItem[]; onOpen: (it: GoldenItem) => void }) {
  const rows = Math.ceil(items.length / COLS);
  const onClick = (e: MouseEvent<SVGSVGElement>) => {
    const i = Number((e.target as SVGElement).getAttribute('data-i'));
    if (Number.isInteger(i) && items[i]) onOpen(items[i]);
  };
  return (
    <svg
      viewBox={`0 0 ${COLS * 10} ${rows * 10}`}
      className="block h-auto w-full cursor-pointer"
      role="img"
      aria-label={`${items.length} plates, ${items.filter((i) => !i.correct).length} wrong`}
      onClick={onClick}
    >
      {items.map((it, i) => (
        <rect
          key={it.key}
          data-i={i}
          x={(i % COLS) * 10 + 1}
          y={Math.floor(i / COLS) * 10 + 1}
          width={8}
          height={8}
          rx={1.5}
          className={it.correct ? 'fill-success/55 hover:fill-success' : 'fill-danger hover:fill-danger/70'}
        >
          {!it.correct && <title>{`${it.gt} read as ${it.pred}`}</title>}
        </rect>
      ))}
    </svg>
  );
}

function HowMeasured({ r }: { r: GoldenResults }) {
  const minLab = minLabelers(r.items);
  return (
    <Popover
      align="start"
      trigger={
        <span className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
          <InfoIcon size={13} aria-hidden /> How it's measured
        </span>
      }
      panelClassName="w-[min(360px,calc(100vw-2rem))] p-3"
    >
      <dl className="space-y-2 text-xs">
        {[
          ['What ran', `Each plate crop was sent to the live model API (${endpointPath(r.endpoint)}) and the returned read — after the production plate-format grammar — was stored as-is.`],
          ['Ground truth', `Every plate was labelled by at least ${minLab} people independently, without seeing the model's output.`],
          ['What counts', 'Exact match of the whole plate after removing spaces. One wrong or missing character = wrong; no partial credit.'],
          ['What is excluded', `${fmtInt(r.unreadable)} of ${fmtInt(r.totalImages)} images the labellers marked unreadable (no ground truth exists), per the team protocol.`],
          ['Set fingerprint', <span key="h" className="break-all font-mono text-2xs">{r.setHash || '—'}</span>],
        ].map(([k, v]) => (
          <div key={String(k)}>
            <dt className="font-semibold text-fg">{k}</dt>
            <dd className="mt-0.5 text-fg-muted">{v}</dd>
          </div>
        ))}
      </dl>
    </Popover>
  );
}

export function Hero({ r, onOpen }: { r: GoldenResults; onOpen: (it: GoldenItem) => void }) {
  const { n, correct } = r.overall;
  const acc = n ? correct / n : r.overall.accuracy;
  const wrong = n - correct;
  const pass = acc > PS_TARGET;
  const margin = (acc - PS_TARGET) * 100;
  return (
    <section aria-labelledby="gs-hero" className="overflow-hidden rounded-md border border-line bg-surface">
      <div className="grid gap-5 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="gs-hero" className="text-2xs font-semibold uppercase tracking-[0.08em] text-fg-subtle">Plate OCR accuracy · golden set</h2>
            <Badge tone="success" icon={<ShieldCheckIcon />}>Live model API run — not a simulation</Badge>
          </div>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
            <div className="text-[64px] font-semibold leading-none tracking-[-0.03em] text-fg tabular-nums sm:text-[88px]" data-testid="gs-accuracy">
              {pct(acc)}
              <span className="ml-1 text-[32px] font-medium text-fg-muted sm:text-[44px]">%</span>
            </div>
            <p className="max-w-[26ch] pb-2 text-sm text-fg-muted">
              plate OCR accuracy on <span className="font-semibold text-fg">{fmtInt(n)}</span> real, human-labelled Indian number plates
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="success" size="md" icon={<CircleCheckIcon />}>{fmtInt(correct)} correct</Badge>
            <Badge tone="danger" size="md" icon={<CircleXIcon />}>{fmtInt(wrong)} wrong</Badge>
            <Badge tone={pass ? 'success' : 'danger'} variant="solid" size="md" icon={<TargetIcon />}>
              {pass ? 'Meets' : 'Below'} PS target &gt; {Math.round(PS_TARGET * 100)}% {pass ? '✓' : '✗'}
            </Badge>
            <span className="text-xs tabular-nums text-fg-muted">
              {margin >= 0 ? '+' : ''}
              {margin.toFixed(2)} pts
            </span>
          </div>
          {/* accuracy vs target, full 0–100 scale */}
          <div className="max-w-xl pt-1">
            <div className="relative h-2.5 rounded-full bg-surface-3">
              <div className={cn('h-full rounded-full', pass ? 'bg-success' : 'bg-danger')} style={{ width: `${acc * 100}%` }} />
              <div className="absolute -top-1 bottom-[-4px] w-0.5 bg-fg" style={{ left: `${PS_TARGET * 100}%` }} aria-hidden />
            </div>
            <div className="relative mt-1 h-4 text-2xs text-fg-subtle">
              <span className="absolute left-0">0%</span>
              <span className="absolute -translate-x-1/2 whitespace-nowrap font-medium text-fg-muted" style={{ left: `${PS_TARGET * 100}%` }}>90% target</span>
            </div>
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-3 self-start rounded-md border border-line bg-surface-2 p-3 text-xs lg:grid-cols-1">
          <div>
            <dt className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle"><TimerIcon size={12} aria-hidden />Model time per plate</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums text-fg">
              {r.latency.p50 != null ? `${Math.round(r.latency.p50)} ms` : '—'}
              <span className="ml-1.5 text-xs font-normal text-fg-muted">p50{r.latency.p95 != null ? ` · p95 ${Math.round(r.latency.p95)} ms` : ''}</span>
            </dd>
          </div>
          <div>
            <dt className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle"><CalendarClockIcon size={12} aria-hidden />Measured</dt>
            <dd className="mt-0.5 font-medium tabular-nums text-fg">{fmtMeasuredAt(r.measuredAt)}</dd>
          </div>
          <div className="col-span-2 lg:col-span-1">
            <dt className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle"><FingerprintIcon size={12} aria-hidden />Labelled set</dt>
            <dd className="mt-0.5 font-mono text-[12px] text-fg" title={r.setHash}>
              {r.set} · {shortHash(r.setHash)}
            </dd>
          </div>
          <div className="col-span-2 lg:col-span-1">
            <HowMeasured r={r} />
          </div>
        </dl>
      </div>
      <div className="border-t border-line bg-surface-2/60 px-4 py-3 sm:px-5">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-2xs text-fg-subtle">
          <span>Every scored plate, one square each — <span className="font-medium text-danger">red</span> = wrong read. Click any square to open that plate.</span>
          <span className="tabular-nums">{fmtInt(n)} plates</span>
        </div>
        <PlateMap items={r.items} onOpen={onOpen} />
      </div>
    </section>
  );
}
