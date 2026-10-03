// ═══════════════════════════════════════════════════
// Figures the Model Performance page derives from the golden-set results
// (public/golden/results_golden_v1.json) and the PS target in
// public/eval/results.json. Nothing here is a constant measurement: every
// number is computed from the loaded files.
// ═══════════════════════════════════════════════════

import type { GoldenItem, GoldenResults } from '@/features/golden-set/lib/results';

export interface GoldenHeadline {
  n: number;
  correct: number;
  wrong: number;
  /** correct / n (exact whole-plate matches). */
  accuracy: number;
  /** Images the labellers marked unreadable, not scored. */
  unreadable: number;
  totalImages: number;
  measuredAt: string;
}

export function goldenHeadline(g: GoldenResults): GoldenHeadline {
  const { n, correct } = g.overall;
  return {
    n,
    correct,
    wrong: n - correct,
    accuracy: n ? correct / n : g.overall.accuracy,
    unreadable: g.unreadable,
    totalImages: g.totalImages,
    measuredAt: g.measuredAt,
  };
}

export interface TargetMargin {
  /** True when accuracy is strictly above the target ("> 90%"). */
  met: boolean;
  /** (accuracy − target) in percentage points; negative when below. */
  points: number;
}

export function targetMargin(accuracy: number, target: number): TargetMargin {
  return { met: accuracy > target, points: (accuracy - target) * 100 };
}

/** Default number of golden plates shown in "Real reads". */
export const REAL_READS_COUNT = 12;

/** FNV-1a 32-bit hash of a string (seed material). */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG: deterministic for a given seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seeded uniform random sample of the scored plates: same file → same plates,
 * no selection by result, so wrong reads appear at their natural rate (often
 * none in a sample this small). The seed is the set's own hash.
 */
export function sampleGoldenItems(items: GoldenItem[], seed: string, count = REAL_READS_COUNT): GoldenItem[] {
  const idx = items.map((_, i) => i);
  const rand = mulberry32(hash32(seed));
  const k = Math.min(count, idx.length);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rand() * (idx.length - i));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, k).map((i) => items[i]);
}
