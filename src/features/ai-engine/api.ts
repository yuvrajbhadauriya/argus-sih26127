// ═══════════════════════════════════════════════════
// AI engine status — data access for public.model_status.
//
// The GPU watchdog upserts row id='gpu-primary' (heartbeat every ~10 s while
// running, ~2 s while starting). The database is private, so the dashboard
// polls GET /api/data/model-status every 5 s (CDN-cached for 2 s, so all
// viewers share one query). Failures are quiet by design: an unreachable
// engine is a status to display, not an error to log.
// ═══════════════════════════════════════════════════

import { isSupabaseConfigured } from '@/lib/supabase/client';
import { apiRow } from '@/lib/dataApi';
import { parseModelStatusRow, type ModelStatusRow } from './lib/status';

export const MODEL_STATUS_ID = 'gpu-primary';
export const MODEL_STATUS_POLL_MS = 5_000;

/** The engine row, or null when there is none. Throws on a request error. */
export async function fetchModelStatus(): Promise<ModelStatusRow | null> {
  if (!isSupabaseConfigured()) return null;
  return parseModelStatusRow(await apiRow('model-status'));
}
