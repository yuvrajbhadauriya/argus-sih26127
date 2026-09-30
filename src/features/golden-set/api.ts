// Loads the published golden-set OCR run (public/golden/, written by
// pipeline/tools/upload_golden.py). The plate crops themselves live in the
// private Supabase Storage bucket `golden` (`bucket` + `prefix` in the file) and
// are shown through short-lived signed URLs (lib/signedUrls.ts → /api/media/sign).

import { useCallback, useEffect, useState } from 'react';
import { parseGoldenResults, type GoldenResults } from './lib/results';

export const GOLDEN_RESULTS_URL = '/golden/results_golden_v1.json';

export async function fetchGoldenResults(): Promise<GoldenResults> {
  const res = await fetch(GOLDEN_RESULTS_URL);
  if (!res.ok) throw new Error(`Golden-set results not published (${GOLDEN_RESULTS_URL} → HTTP ${res.status})`);
  return parseGoldenResults(await res.json());
}

export function useGoldenResults() {
  const [state, setState] = useState<{ data: GoldenResults | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    fetchGoldenResults().then(
      (data) => alive && setState({ data, error: null, loading: false }),
      (e: unknown) => alive && setState({ data: null, error: e instanceof Error ? e.message : 'Failed to load results', loading: false }),
    );
    return () => {
      alive = false;
    };
  }, [nonce]);
  const retry = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: null }));
    setNonce((n) => n + 1);
  }, []);
  return { ...state, retry };
}
