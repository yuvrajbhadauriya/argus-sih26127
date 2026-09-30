// Loads the evaluation outputs published under public/eval/ (static files) and
// the live model-API health probe (/api/health, optional).

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

export interface ModelHealth {
  configured: boolean;
  reachable: boolean | null;
  latency_ms: number | null;
}

/** Optional: null when /api/health is not deployed (e.g. `vite dev`). */
export async function fetchModelHealth(): Promise<ModelHealth | null> {
  try {
    const res = await fetch('/api/health');
    const body = (await res.json()) as Partial<ModelHealth> | null;
    if (!body || typeof body.configured !== 'boolean') return null;
    return { configured: body.configured, reachable: body.reachable ?? null, latency_ms: body.latency_ms ?? null };
  } catch {
    return null;
  }
}
