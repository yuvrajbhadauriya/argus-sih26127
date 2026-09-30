import { describe, expect, it } from 'vitest';
import { initialReel, prefixSums, reelDelay, reelReducer, runningTally, REEL_TIMING, type ReelState } from './reel';

const seq = [0, 1, 2];
const adv = (s: ReelState, len = 3) => reelReducer(s, { type: 'advance', readLength: len });

describe('reel state machine', () => {
  it('walks scan → type (char by char) → meter → verdict → next plate', () => {
    let s = initialReel(seq);
    expect(s).toMatchObject({ pos: 0, phase: 'scan', typed: 0, playing: true });
    s = adv(s);
    expect(s).toMatchObject({ phase: 'type', typed: 0 });
    s = adv(adv(adv(s)));
    expect(s).toMatchObject({ phase: 'type', typed: 3 });
    s = adv(s);
    expect(s.phase).toBe('meter');
    s = adv(s);
    expect(s.phase).toBe('verdict');
    s = adv(s);
    expect(s).toMatchObject({ pos: 1, phase: 'scan', typed: 0 });
  });

  it('wraps around at the end of the sequence', () => {
    let s: ReelState = { ...initialReel(seq), pos: 2, phase: 'verdict' };
    s = adv(s);
    expect(s.pos).toBe(0);
  });

  it('pause keeps the frame; play on a finished card moves on', () => {
    let s = reelReducer(initialReel(seq), { type: 'pause' });
    expect(s).toMatchObject({ playing: false, phase: 'scan' });
    s = reelReducer(s, { type: 'play' });
    expect(s).toMatchObject({ playing: true, phase: 'scan', pos: 0 });
    s = reelReducer({ ...s, phase: 'verdict' }, { type: 'toggle' });
    expect(s.playing).toBe(false);
    s = reelReducer(s, { type: 'toggle' });
    expect(s).toMatchObject({ playing: true, pos: 1, phase: 'scan' });
  });

  it('manual stepping while paused shows the full result (reduced-motion mode)', () => {
    let s = initialReel(seq, { playing: false });
    expect(s).toMatchObject({ phase: 'verdict', playing: false });
    s = reelReducer(s, { type: 'next' });
    expect(s).toMatchObject({ pos: 1, phase: 'verdict' });
    expect(s.typed).toBeGreaterThan(100);
    s = reelReducer(reelReducer(s, { type: 'prev' }), { type: 'prev' });
    expect(s.pos).toBe(2);
  });

  it('stepping while playing restarts the animation on the new plate', () => {
    const s = reelReducer({ ...initialReel(seq), phase: 'meter' }, { type: 'next' });
    expect(s).toMatchObject({ pos: 1, phase: 'scan', typed: 0 });
  });

  it('mistakes-only swaps the sequence and restarts', () => {
    const s = reelReducer({ ...initialReel(seq), pos: 2 }, { type: 'mistakesOnly', on: true, seq: [7, 9] });
    expect(s).toMatchObject({ seq: [7, 9], pos: 0, mistakesOnly: true, phase: 'scan' });
  });

  it('delays scale with speed', () => {
    const s = initialReel(seq);
    expect(reelDelay(s)).toBe(REEL_TIMING.scan);
    expect(reelDelay({ ...s, speed: 4 })).toBe(REEL_TIMING.scan / 4);
    expect(reelDelay({ ...s, phase: 'type' })).toBe(REEL_TIMING.perChar);
    expect(reelDelay({ ...s, phase: 'verdict', speed: 2 })).toBe(REEL_TIMING.verdict / 2);
  });

  it('an empty sequence never advances', () => {
    const s = initialReel([]);
    expect(adv(s)).toBe(s);
  });

  it('running tally counts the current plate once its verdict shows', () => {
    const ok = [true, false, true];
    const prefix = prefixSums(seq, (i) => ok[i]);
    expect(prefix).toEqual([0, 1, 1, 2]);
    const s = initialReel(seq);
    expect(runningTally(s, prefix)).toEqual({ verified: 0, correct: 0 });
    expect(runningTally({ ...s, phase: 'verdict' }, prefix)).toEqual({ verified: 1, correct: 1 });
    expect(runningTally({ ...s, pos: 2, phase: 'type' }, prefix)).toEqual({ verified: 2, correct: 1 });
    expect(runningTally({ ...s, pos: 2, phase: 'verdict' }, prefix)).toEqual({ verified: 3, correct: 2 });
  });
});
