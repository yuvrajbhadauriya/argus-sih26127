import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildVerifiedFile, fetchVerified, parseVerified, verifiedAccuracy, wilson95, type Label } from './verification';

const L = (v: Label['verdict'], truth?: string): Label => ({ verdict: v, ...(truth ? { truth } : {}) });

describe('verifiedAccuracy', () => {
  it('is correct / (correct + wrong); unreadable is excluded and counted separately', () => {
    const a = verifiedAccuracy({ a: L('correct'), b: L('correct'), c: L('correct'), d: L('wrong', 'X'), e: L('unreadable'), f: L('unreadable') });
    expect(a).toMatchObject({ correct: 3, wrong: 1, unreadable: 2, n: 4, accuracy: 0.75 });
    expect(a.ci!.low).toBeLessThan(0.75);
    expect(a.ci!.high).toBeGreaterThan(0.75);
  });
  it('has no accuracy with no labels', () => {
    expect(verifiedAccuracy({})).toEqual({ correct: 0, wrong: 0, unreadable: 0, n: 0, accuracy: null, ci: null });
  });
  it('has no accuracy when every read is unreadable', () => {
    const a = verifiedAccuracy({ a: L('unreadable'), b: L('unreadable') });
    expect(a.n).toBe(0);
    expect(a.unreadable).toBe(2);
    expect(a.accuracy).toBeNull();
    expect(a.ci).toBeNull();
  });
  it('ignores labels of reads that do not exist when validKeys is given', () => {
    const a = verifiedAccuracy({ a: L('correct'), gone: L('wrong') }, new Set(['a']));
    expect(a).toMatchObject({ correct: 1, wrong: 0, n: 1, accuracy: 1 });
  });
});

describe('wilson95', () => {
  it('matches the known interval for 8/10', () => {
    const w = wilson95(8, 10)!;
    expect(w.low).toBeCloseTo(0.4902, 3);
    expect(w.high).toBeCloseTo(0.9433, 3);
  });
  it('stays inside [0, 1] at the extremes and is null for n = 0', () => {
    expect(wilson95(10, 10)!.high).toBeCloseTo(1, 10);
    expect(wilson95(10, 10)!.low).toBeCloseTo(0.7225, 3);
    expect(wilson95(0, 10)!.low).toBe(0);
    expect(wilson95(0, 0)).toBeNull();
  });
});

describe('parseVerified / buildVerifiedFile', () => {
  it('rejects missing, wrong-schema and empty files', () => {
    expect(parseVerified(null)).toBeNull();
    expect(parseVerified({ schema: 2, labels: { a: { verdict: 'correct' } } })).toBeNull();
    expect(parseVerified({ schema: 1, labels: {} })).toBeNull();
    expect(parseVerified({ schema: 1, labels: { a: { verdict: 'maybe' } } })).toBeNull();
  });
  it('reads the documented format', () => {
    const f = parseVerified({ schema: 1, verified_by: 'A', verified_at: '2026-10-04', labels: { a: { verdict: 'wrong', truth: 'MH12AB1234' }, b: { verdict: 'correct' } } })!;
    expect(f.verified_by).toBe('A');
    expect(f.labels.a).toEqual({ verdict: 'wrong', truth: 'MH12AB1234' });
  });
  it('writes exactly the documented format (and round-trips)', () => {
    const file = buildVerifiedFile({ a: L('wrong', 'MH12AB1234'), b: { verdict: 'correct', truth: '' } }, 'A', '2026-10-04T00:00:00Z');
    expect(file).toEqual({ schema: 1, verified_by: 'A', verified_at: '2026-10-04T00:00:00Z', labels: { a: { verdict: 'wrong', truth: 'MH12AB1234' }, b: { verdict: 'correct' } } });
    expect(parseVerified(JSON.parse(JSON.stringify(file)))).toEqual(file);
  });
});

describe('fetchVerified', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('is null when the file is missing, not JSON, or the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    expect(await fetchVerified()).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('html'); } })));
    expect(await fetchVerified()).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await fetchVerified()).toBeNull();
  });
});
