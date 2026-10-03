// Loads the evaluation output published under public/eval/ (static file).
// The live model API's state is the AI engine status (model_status), not probed here.

import { parseEvalResults, type EvalResults } from './lib/results';

export const RESULTS_URL = '/eval/results.json';

export async function fetchEvalResults(): Promise<EvalResults> {
  const res = await fetch(RESULTS_URL, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`No evaluation results published (${RESULTS_URL} → HTTP ${res.status})`);
  return parseEvalResults(await res.json());
}
