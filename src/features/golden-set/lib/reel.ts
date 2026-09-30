// ═══════════════════════════════════════════════════
// Live-proof reel — a pure state machine that replays the recorded golden-set
// run one plate at a time:
//   scan (scan line sweeps the crop) → type (the read appears char by char)
//   → meter (confidence bar fills) → verdict (✓ / ✗ held on screen) → next.
// The React hook (useReel) only schedules `advance` with reelDelay().
// ═══════════════════════════════════════════════════

export type ReelPhase = 'scan' | 'type' | 'meter' | 'verdict';
export type ReelSpeed = 1 | 2 | 4;

export interface ReelState {
  /** Indices into the item list, in play order. */
  seq: number[];
  /** Position in seq. */
  pos: number;
  phase: ReelPhase;
  /** Characters of the read shown so far (type phase). */
  typed: number;
  playing: boolean;
  speed: ReelSpeed;
  mistakesOnly: boolean;
}

export type ReelAction =
  | { type: 'advance'; readLength: number }
  | { type: 'toggle' }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'speed'; speed: ReelSpeed }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'mistakesOnly'; on: boolean; seq: number[] };

/** Base timings at 1× (ms). */
export const REEL_TIMING = { scan: 800, perChar: 70, meter: 600, verdict: 1300 } as const;

export function initialReel(seq: number[], opts: { playing?: boolean } = {}): ReelState {
  const playing = opts.playing ?? true;
  return { seq, pos: 0, phase: playing ? 'scan' : 'verdict', typed: playing ? 0 : Number.MAX_SAFE_INTEGER, playing, speed: 1, mistakesOnly: false };
}

/** Fully revealed state of an item (used when stepping manually or while paused). */
function revealed(s: ReelState, pos: number): ReelState {
  return { ...s, pos, phase: 'verdict', typed: Number.MAX_SAFE_INTEGER };
}

function fresh(s: ReelState, pos: number): ReelState {
  return { ...s, pos, phase: 'scan', typed: 0 };
}

const wrap = (pos: number, len: number) => (len ? ((pos % len) + len) % len : 0);

export function reelReducer(s: ReelState, a: ReelAction): ReelState {
  switch (a.type) {
    case 'advance': {
      if (!s.seq.length) return s;
      switch (s.phase) {
        case 'scan':
          return { ...s, phase: 'type', typed: 0 };
        case 'type':
          return s.typed < a.readLength ? { ...s, typed: s.typed + 1 } : { ...s, phase: 'meter' };
        case 'meter':
          return { ...s, phase: 'verdict' };
        case 'verdict':
          return fresh(s, wrap(s.pos + 1, s.seq.length));
      }
      return s;
    }
    case 'toggle':
      return reelReducer(s, { type: s.playing ? 'pause' : 'play' });
    case 'play':
      // Resuming on a finished card moves on to the next plate.
      return s.phase === 'verdict' ? { ...fresh(s, wrap(s.pos + 1, s.seq.length)), playing: true } : { ...s, playing: true };
    case 'pause':
      return { ...s, playing: false };
    case 'speed':
      return { ...s, speed: a.speed };
    case 'next':
    case 'prev': {
      const pos = wrap(s.pos + (a.type === 'next' ? 1 : -1), s.seq.length);
      return s.playing ? fresh(s, pos) : revealed(s, pos);
    }
    case 'mistakesOnly': {
      const next = { ...s, seq: a.seq, mistakesOnly: a.on };
      return s.playing ? fresh(next, 0) : revealed(next, 0);
    }
  }
}

/** How long the current step stays on screen before the next `advance`. */
export function reelDelay(s: ReelState): number {
  const base =
    s.phase === 'scan' ? REEL_TIMING.scan : s.phase === 'type' ? REEL_TIMING.perChar : s.phase === 'meter' ? REEL_TIMING.meter : REEL_TIMING.verdict;
  return Math.round(base / s.speed);
}

/** Has the current item's verdict been revealed? */
export const verdictShown = (s: ReelState) => s.phase === 'verdict';

/**
 * Running tally for the counter: plates verified so far in play order (the
 * current one counts once its verdict is shown) and how many were correct.
 * `prefixCorrect[i]` = correct among seq[0..i).
 */
export function runningTally(s: ReelState, prefixCorrect: number[]): { verified: number; correct: number } {
  const verified = Math.min(s.seq.length, s.pos + (verdictShown(s) ? 1 : 0));
  return { verified, correct: prefixCorrect[verified] ?? 0 };
}

export function prefixSums(seq: number[], isCorrect: (i: number) => boolean): number[] {
  const out = [0];
  for (const i of seq) out.push(out[out.length - 1] + (isCorrect(i) ? 1 : 0));
  return out;
}
