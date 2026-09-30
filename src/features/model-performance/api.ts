// Loads the evaluation outputs published under public/eval/ (static files) and
// (the live model API's state is the AI engine status, not probed here).

import { parseEvalResults, parseVideoConsistency, type EvalResults, type VideoConsistency } from './lib/results';

export const RESULTS_URL = '/eval/results.json';
export const VIDEO_URL = '/eval/video_consistency.json';

export async function fetchEvalResults(): Promise<EvalResults> {
  const res = await fetch(RESULTS_URL, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`No evaluation results published (${RESULTS_URL} → HTTP ${res.status})`);
  return parseEvalResults(await res.json());
}

/** Optional: null when the file is absent or unreadable. */
export async function fetchVideoConsistency(): Promise<VideoConsistency | null> {
  try {
    const res = await fetch(VIDEO_URL, { cache: 'no-cache' });
    if (!res.ok) return null;
    return parseVideoConsistency(await res.json());
  } catch {
    return null;
  }
}
