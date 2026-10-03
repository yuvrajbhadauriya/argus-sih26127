import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseGoldenResults, type GoldenItem } from '@/features/golden-set/lib/results';
import { goldenHeadline, sampleGoldenItems, targetMargin } from './goldenHeadline';

const golden = parseGoldenResults(JSON.parse(readFileSync(resolve(process.cwd(), 'public/golden/results_golden_v1.json'), 'utf8')));
const mk = (i: number): GoldenItem => ({ key: `k${i}`, gt: `P${i}`, pred: `P${i}`, confidence: 90, correct: i % 10 !== 0, grammarValid: true, rowCount: 1, side: 'front', stateCode: 'MH', conditions: [], labelers: 2, width: 10, height: 5, inferenceMs: null, roundtripMs: null });

describe('goldenHeadline', () => {
  it('derives every figure from the file', () => {
    const h = goldenHeadline(golden);
    expect(h.accuracy).toBe(golden.overall.correct / golden.overall.n);
    expect(h.wrong).toBe(golden.overall.n - golden.overall.correct);
    expect(h.unreadable).toBe(golden.unreadable);
    expect(h.totalImages).toBe(golden.totalImages);
  });
});

describe('targetMargin', () => {
  it('is met strictly above the target, with signed points', () => {
    expect(targetMargin(0.9887, 0.9)).toEqual({ met: true, points: expect.closeTo(8.87, 2) });
    expect(targetMargin(0.8, 0.9)).toEqual({ met: false, points: expect.closeTo(-10, 5) });
    expect(targetMargin(0.9, 0.9).met).toBe(false);
  });
});

describe('sampleGoldenItems', () => {
  const items = Array.from({ length: 200 }, (_, i) => mk(i));
  it('is deterministic for a seed, distinct, and sized as asked', () => {
    const a = sampleGoldenItems(items, 'seed');
    expect(a).toHaveLength(12);
    expect(sampleGoldenItems(items, 'seed')).toEqual(a);
    expect(new Set(a.map((x) => x.key)).size).toBe(12);
    expect(sampleGoldenItems(items, 'other').map((x) => x.key)).not.toEqual(a.map((x) => x.key));
  });
  it('does not select by result (uniform draw: wrong reads can be absent or present)', () => {
    const rates = Array.from({ length: 300 }, (_, s) => sampleGoldenItems(items, `s${s}`).filter((x) => !x.correct).length);
    const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
    expect(mean).toBeGreaterThan(0.7); // natural rate is 10% of 12 = 1.2
    expect(mean).toBeLessThan(1.7);
  });
  it('handles small sets', () => {
    expect(sampleGoldenItems(items.slice(0, 3), 'x')).toHaveLength(3);
    expect(sampleGoldenItems([], 'x')).toEqual([]);
  });
});
