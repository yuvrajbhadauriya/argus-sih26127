// ═══════════════════════════════════════════════════
// Human verification of camera-feed reads (public/eval/camera_reads_verified.json).
// Accuracy comes ONLY from these human verdicts, never from the model's own
// confidence. Same protocol as the golden set: exact whole-plate match, no
// partial credit; "unreadable" reads are excluded from the denominator.
// ═══════════════════════════════════════════════════

export const VERIFIED_URL = '/eval/camera_reads_verified.json';

export type Verdict = 'correct' | 'wrong' | 'unreadable';

export interface Label {
  verdict: Verdict;
  /** The true plate text, when the verifier typed it (optional). */
  truth?: string;
}

export interface VerifiedFile {
  schema: 1;
  verified_by: string;
  verified_at: string;
  labels: Record<string, Label>;
}

export interface VerifiedAccuracy {
  correct: number;
  wrong: number;
  unreadable: number;
  /** correct + wrong (unreadable excluded). */
  n: number;
  /** correct / n, or null when n = 0. */
  accuracy: number | null;
  /** 95% Wilson score interval, or null when n = 0. */
  ci: { low: number; high: number } | null;
}

const Z95 = 1.959963984540054;

/** 95% Wilson score interval for `k` successes in `n` trials (null when n = 0). */
export function wilson95(k: number, n: number): { low: number; high: number } | null {
  if (!(n > 0)) return null;
  const p = k / n;
  const z2 = Z95 * Z95;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** Accuracy = correct / (correct + wrong). `validKeys` restricts to labels of reads that exist. */
export function verifiedAccuracy(labels: Record<string, Label>, validKeys?: ReadonlySet<string>): VerifiedAccuracy {
  let correct = 0;
  let wrong = 0;
  let unreadable = 0;
  for (const [key, l] of Object.entries(labels)) {
    if (validKeys && !validKeys.has(key)) continue;
    if (l.verdict === 'correct') correct++;
    else if (l.verdict === 'wrong') wrong++;
    else if (l.verdict === 'unreadable') unreadable++;
  }
  const n = correct + wrong;
  return { correct, wrong, unreadable, n, accuracy: n > 0 ? correct / n : null, ci: wilson95(correct, n) };
}

const VERDICTS = new Set<string>(['correct', 'wrong', 'unreadable']);

/** Parses the file; null for anything that is not a valid verification file with at least one label. */
export function parseVerified(raw: unknown): VerifiedFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.schema !== 1 || !r.labels || typeof r.labels !== 'object') return null;
  const labels: Record<string, Label> = {};
  for (const [k, v] of Object.entries(r.labels as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    if (typeof o.verdict !== 'string' || !VERDICTS.has(o.verdict)) continue;
    labels[k] = { verdict: o.verdict as Verdict, ...(typeof o.truth === 'string' && o.truth ? { truth: o.truth } : {}) };
  }
  if (Object.keys(labels).length === 0) return null;
  return {
    schema: 1,
    verified_by: typeof r.verified_by === 'string' ? r.verified_by : '',
    verified_at: typeof r.verified_at === 'string' ? r.verified_at : '',
    labels,
  };
}

/** Loads the verification file; null when missing, unreadable or empty ("Verification pending"). */
export async function fetchVerified(): Promise<VerifiedFile | null> {
  try {
    const res = await fetch(VERIFIED_URL, { cache: 'no-cache' });
    if (!res.ok) return null;
    return parseVerified(await res.json());
  } catch {
    return null;
  }
}

/** The exact file the dev verification tool downloads. */
export function buildVerifiedFile(labels: Record<string, Label>, verifiedBy: string, verifiedAt: string): VerifiedFile {
  const clean: Record<string, Label> = {};
  for (const [k, l] of Object.entries(labels)) {
    clean[k] = { verdict: l.verdict, ...(l.truth ? { truth: l.truth } : {}) };
  }
  return { schema: 1, verified_by: verifiedBy, verified_at: verifiedAt, labels: clean };
}
