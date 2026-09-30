// ═══════════════════════════════════════════════════
// LiveReel — replays the recorded golden-set API run plate by plate: the real
// crop, a scan line, the model's read typing in, the confidence filling, then
// the verdict against the human label, with a running accuracy counter.
// Under prefers-reduced-motion it is a static step-through (no autoplay).
// ═══════════════════════════════════════════════════

import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ChevronLeftIcon, ChevronRightIcon, PauseIcon, PlayIcon, ScanLineIcon, TriangleAlertIcon } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { Panel } from '@/shared/ui/Card';
import { Badge } from '@/shared/ui/Badge';
import { Button, IconButton } from '@/shared/ui/Button';
import { usePrefersReducedMotion } from '@/features/vehicles/hooks/usePrefersReducedMotion';
import { VIDEO_OVERLAY } from '@/shared/theme/tokens';
import { conditionLabel, fmtInt, fmtMeasuredDate, plateVariant, type GoldenResults } from '../lib/results';
import { useCropUrls } from '../lib/useCropUrls';
import { initialReel, prefixSums, reelDelay, reelReducer, runningTally, type ReelSpeed, type ReelState } from '../lib/reel';
import { diffMarks } from '../lib/diff';
import { ConfidenceBar, CropImage, PlateRead, VerdictIcon } from './parts';

const SPEEDS: ReelSpeed[] = [1, 2, 4];
const REDUCED_STEP_MS = 2600;
/** Plates signed ahead of the one on screen. */
const LOOKAHEAD = 8;

/** Pause scheduling while the reel is off-screen or the tab is hidden. */
function useActive(ref: React.RefObject<HTMLElement | null>): boolean {
  const [inView, setInView] = useState(true);
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold: 0.15 });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  useEffect(() => {
    const on = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return inView && visible;
}

export function LiveReel({ results }: { results: GoldenResults }) {
  const { items } = results;
  const reduced = usePrefersReducedMotion();
  const allSeq = useMemo(() => items.map((_, i) => i), [items]);
  const mistakeSeq = useMemo(() => allSeq.filter((i) => !items[i].correct), [allSeq, items]);
  const [state, dispatch] = useReducer(reelReducer, undefined, () => initialReel(allSeq, { playing: !reduced }));
  const rootRef = useRef<HTMLElement>(null);
  const active = useActive(rootRef);

  // Reduced motion: never animate the phases; show each plate fully revealed.
  const s: ReelState = reduced ? { ...state, phase: 'verdict', typed: Number.MAX_SAFE_INTEGER } : state;
  const idx = s.seq[s.pos] ?? 0;
  const it = items[idx];

  useEffect(() => {
    if (!state.playing || !active || !state.seq.length) return;
    const t = setTimeout(
      () => (reduced ? dispatch({ type: 'next' }) : dispatch({ type: 'advance', readLength: items[state.seq[state.pos]]?.pred.length ?? 0 })),
      reduced ? REDUCED_STEP_MS / state.speed : reelDelay(state),
    );
    return () => clearTimeout(t);
  }, [state, active, reduced, items]);

  // Sign the current plate and a few ahead in one batch; warm the next image.
  const lookahead = useMemo(() => {
    const n = state.seq.length;
    return Array.from({ length: Math.min(LOOKAHEAD, n) }, (_, k) => items[state.seq[(state.pos + k) % n]]);
  }, [state.pos, state.seq, items]);
  const urls = useCropUrls(results, lookahead);
  const nextUrl = lookahead[1] ? urls.url(lookahead[1]) : undefined;
  useEffect(() => {
    if (!nextUrl || typeof Image === 'undefined') return;
    const img = new Image();
    img.src = nextUrl;
  }, [nextUrl]);

  const prefix = useMemo(() => prefixSums(s.seq, (i) => items[i].correct), [s.seq, items]);
  const tally = runningTally(s, prefix);
  const variant = plateVariant(it);
  const typedText = it.pred.slice(0, s.typed);
  const showMeter = s.phase === 'meter' || s.phase === 'verdict';
  const showVerdict = s.phase === 'verdict';
  const marks = useMemo(() => diffMarks(it.gt, it.pred), [it]);
  const progress = s.seq.length ? ((s.pos + (showVerdict ? 1 : 0)) / s.seq.length) * 100 : 0;

  const controls = (
    <div className="flex items-center gap-1">
      <IconButton label="Previous plate" size="sm" icon={<ChevronLeftIcon size={16} />} onClick={() => dispatch({ type: 'prev' })} />
      <IconButton
        label={state.playing ? 'Pause' : 'Play'}
        size="sm"
        variant="secondary"
        icon={state.playing ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
        onClick={() => dispatch({ type: 'toggle' })}
      />
      <IconButton label="Next plate" size="sm" icon={<ChevronRightIcon size={16} />} onClick={() => dispatch({ type: 'next' })} />
    </div>
  );

  return (
    <Panel
      id="live-proof"
      title="Live proof"
      subtitle={<span className="hidden sm:inline">every plate, read and score below is from the recorded run</span>}
      icon={<ScanLineIcon />}
      actions={controls}
      className="scroll-mt-4"
    >
      <section ref={rootRef} aria-label="Replay of the recorded model run" className="space-y-3">
        {/* counter + options */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1" aria-live="polite" aria-atomic="true">
            {state.mistakesOnly ? (
              <span className="text-[13px] font-semibold tabular-nums text-fg">
                Mistake {fmtInt(s.pos + 1)} of {fmtInt(s.seq.length)}
              </span>
            ) : (
              <>
                <span className="text-[13px] font-semibold tabular-nums text-fg">
                  Verified {fmtInt(tally.verified)} <span className="font-normal text-fg-subtle">/ {fmtInt(s.seq.length)}</span>
                </span>
                <span className="text-[13px] tabular-nums text-fg-muted">
                  {tally.verified ? `${((tally.correct / tally.verified) * 100).toFixed(1)}% correct so far` : 'starting…'}
                  {tally.verified > 0 && <span className="text-fg-subtle"> · {fmtInt(tally.verified - tally.correct)} wrong</span>}
                </span>
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label="Replay speed" className="inline-flex overflow-hidden rounded-sm border border-line-strong">
              {SPEEDS.map((sp) => (
                <button
                  key={sp}
                  type="button"
                  aria-pressed={state.speed === sp}
                  onClick={() => dispatch({ type: 'speed', speed: sp })}
                  className={cn(
                    'h-7 min-w-9 px-2 text-xs font-medium tabular-nums transition-colors',
                    state.speed === sp ? 'bg-primary/12 text-primary' : 'text-fg-muted hover:bg-surface-2 hover:text-fg',
                  )}
                >
                  {sp}×
                </button>
              ))}
            </div>
            <Button
              size="sm"
              variant={state.mistakesOnly ? 'danger' : 'secondary'}
              aria-pressed={state.mistakesOnly}
              icon={<TriangleAlertIcon size={13} />}
              onClick={() => dispatch({ type: 'mistakesOnly', on: !state.mistakesOnly, seq: state.mistakesOnly ? allSeq : mistakeSeq })}
              disabled={!mistakeSeq.length}
            >
              {state.mistakesOnly ? 'Showing mistakes' : 'Only mistakes'}
            </Button>
          </div>
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-surface-3" aria-hidden>
          <div className={cn('h-full transition-[width] duration-300', state.mistakesOnly ? 'bg-danger' : 'bg-primary')} style={{ width: `${progress}%` }} />
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          {/* viewer */}
          <div className="relative h-[180px] overflow-hidden rounded-md border border-line sm:h-[250px]" style={{ backgroundColor: VIDEO_OVERLAY.frameBg }}>
            <CropImage
              key={it.key}
              src={urls.url(it)}
              onBroken={() => urls.broken(it)}
              width={it.width}
              height={it.height}
              alt={`Plate crop, labelled ${it.gt}`}
              eager
              className="absolute inset-0"
              imgClassName="h-full w-full animate-fade-in p-6 sm:p-8"
            />
            {/* viewfinder corners */}
            {['left-3 top-3 border-l-2 border-t-2', 'right-3 top-3 border-r-2 border-t-2', 'bottom-3 left-3 border-b-2 border-l-2', 'bottom-3 right-3 border-b-2 border-r-2'].map((c) => (
              <span key={c} aria-hidden className={cn('pointer-events-none absolute h-4 w-4', c)} style={{ borderColor: VIDEO_OVERLAY.box }} />
            ))}
            {s.phase === 'scan' && !reduced && (
              <div
                key={`scan-${it.key}-${s.pos}`}
                aria-hidden
                className="gs-scan pointer-events-none absolute inset-0"
                style={{
                  background: `linear-gradient(90deg, transparent 0%, transparent 72%, ${VIDEO_OVERLAY.boxGlow.replace('.6', '.08')} 88%, ${VIDEO_OVERLAY.boxGlow} 99%, ${VIDEO_OVERLAY.box} 100%)`,
                  animation: `gs-scan ${reelDelay(state)}ms linear both`,
                }}
              />
            )}
            <div className="pointer-events-none absolute inset-x-3 top-2 flex items-center justify-between font-mono text-[10px] font-semibold uppercase tracking-[0.08em]" style={{ color: VIDEO_OVERLAY.box }}>
              <span className="px-3">{s.phase === 'scan' && !reduced ? 'Scanning…' : 'Plate crop'}</span>
              <span className="px-3 tabular-nums">#{fmtInt(idx + 1)}</span>
            </div>
            <div className="pointer-events-none absolute inset-x-3 bottom-2 flex items-center justify-between px-3 font-mono text-[10px] uppercase tracking-[0.08em] text-white/60">
              <span>{it.side} · {it.rowCount === 2 ? '2 rows' : '1 row'}</span>
              <span className="tabular-nums">{it.width}×{it.height}px</span>
            </div>
          </div>

          {/* read */}
          <div className="flex min-w-0 flex-col gap-3">
            <div>
              <div className="mb-1.5 text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">Model read</div>
              <PlateRead
                text={typedText}
                variant={variant}
                size="xl"
                caret={s.phase === 'type' || s.phase === 'scan'}
                marks={showVerdict && !it.correct ? marks.pred : undefined}
                minChars={Math.max(10, it.pred.length)}
                label={showVerdict ? `Model read ${it.pred}` : 'Model reading…'}
              />
            </div>
            <div>
              <div className="mb-1.5 flex items-baseline justify-between text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">
                <span>Confidence</span>
                <span className={cn('font-mono text-[13px] normal-case tracking-normal tabular-nums', showMeter ? 'text-fg' : 'text-fg-subtle')}>
                  {showMeter ? `${it.confidence.toFixed(1)}%` : '—'}
                </span>
              </div>
              <ConfidenceBar value={it.confidence} fill={showMeter ? it.confidence : 0} />
            </div>
            <div className="min-h-[76px] rounded-md border border-line bg-surface-2 p-3">
              {showVerdict ? (
                <div key={`v-${it.key}`} className="flex items-center gap-3">
                  <VerdictIcon correct={it.correct} size="lg" className={reduced ? undefined : 'gs-pop'} />
                  <div className="min-w-0 space-y-1">
                    {it.correct ? (
                      <>
                        <div className="text-sm font-semibold text-success">Matches the human label</div>
                        <div className="text-xs text-fg-muted">Checked against {it.labelers} independent labellers</div>
                      </>
                    ) : (
                      <>
                        <div className="text-sm font-semibold text-danger">Mismatch — human label</div>
                        <PlateRead text={it.gt} variant={variant} size="sm" marks={marks.gt} label={`Human label ${it.gt}`} />
                      </>
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex h-full min-h-[50px] items-center gap-2 text-xs text-fg-subtle">
                  <span className="h-2 w-2 animate-live-pulse rounded-full bg-primary" aria-hidden />
                  {s.phase === 'scan' ? 'Sending plate crop to the model…' : s.phase === 'type' ? 'Reading characters…' : 'Scoring against the human label…'}
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {it.conditions.map((c) => (
                <Badge key={c} size="sm" tone="info">{conditionLabel(c)}</Badge>
              ))}
              {it.inferenceMs != null && <Badge size="sm">{Math.round(it.inferenceMs)} ms inference</Badge>}
            </div>
          </div>
        </div>
        <p className="text-2xs text-fg-subtle">
          Replaying the recorded live API run of {fmtMeasuredDate(results.measuredAt)} — the images, reads, confidences and verdicts are the real
          outputs, in file order{reduced ? ' (reduced motion: step through with the arrows)' : ''}.
        </p>
      </section>
    </Panel>
  );
}
