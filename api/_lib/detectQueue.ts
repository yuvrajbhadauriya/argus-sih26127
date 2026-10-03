// ═══════════════════════════════════════════════════════════════════════
// Queued detection — how the HOSTED site reaches the GPU without exposing it.
//
// The model API only listens on the Tailscale address, so a Vercel function
// cannot call it. Instead /api/detect drops the frame into the private table
// public.detect_jobs (supabase/migrations/20261003000200_detect_jobs.sql) and
// waits for the answer. A worker on the GPU box (pipeline/gpu_box/detect_worker.py)
// dials OUT to Supabase, claims the frame, posts it to the box's own /v1/frame
// and writes the model's raw answer back. Nothing is opened to the internet.
//
// The worker stores the RAW /v1/frame body; the mapping to the dashboard's
// contract stays in modelAdapter.ts (the one place that knows it).
// ═══════════════════════════════════════════════════════════════════════

import { SupabaseAdmin, UpstreamError } from './supabaseAdmin.js';
import { toBase64, type FrameInput } from './modelAdapter.js';

/** How long one request waits for the GPU (Vercel's default limit is 10 s). */
export const QUEUE_WAIT_MS = 8000;
/** Gap between two looks at the job row. */
export const QUEUE_POLL_MS = 150;
/** Frames sent through the database stay small: a 1080p JPEG at 0.85 is ~0.4 MB. */
export const MAX_QUEUE_IMAGE_BYTES = 2 * 1024 * 1024;

export interface QueueDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
  pollMs?: number;
}

/** The queue could not give an answer; `message` and `status` are safe to send to the browser. */
export class QueueError extends Error {
  readonly status: number;
  readonly retryAfterS: number | null;
  constructor(status: number, message: string, retryAfterS: number | null = null) {
    super(message);
    this.status = status;
    this.retryAfterS = retryAfterS;
  }
}

/** PostgREST / Postgres codes that mean "the migration has not been applied yet". */
const NOT_SET_UP = new Set(['PGRST202', 'PGRST205', '42P01', '42883']);

function fromUpstream(err: unknown): QueueError {
  if (err instanceof QueueError) return err;
  if (err instanceof UpstreamError) {
    if (err.code === 'PT503' || err.status === 503) return new QueueError(503, 'The GPU worker is offline right now.');
    if (err.code === 'PT429' || err.status === 429) return new QueueError(429, 'The GPU is busy — try again in a moment.', 2);
    if ((err.code && NOT_SET_UP.has(err.code)) || err.status === 404) {
      return new QueueError(503, 'Live detection is not set up on this server yet (database migration pending).');
    }
  }
  return new QueueError(502, 'The detection queue is unreachable.');
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface JobRow {
  status: string;
  result: unknown;
  error: string | null;
}

/**
 * Enqueues `frame` and waits for the worker's raw model answer.
 * Throws QueueError (503 no worker, 429 busy, 504 timeout, 502 worker/queue failure).
 */
export async function detectViaQueue(
  admin: SupabaseAdmin,
  frame: FrameInput,
  query: string,
  deps: QueueDeps = {},
): Promise<unknown> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const waitMs = deps.waitMs ?? QUEUE_WAIT_MS;
  const pollMs = deps.pollMs ?? QUEUE_POLL_MS;
  const deadline = now() + waitMs;

  let id: string;
  try {
    const out = await admin.rpc<unknown>('enqueue_detect_job', {
      p_camera_code: frame.cameraCode ?? null,
      p_query: query,
      p_width: frame.width ?? null,
      p_height: frame.height ?? null,
      p_frame_b64: toBase64(frame.bytes),
    });
    if (typeof out !== 'string' || !out) throw new QueueError(502, 'The detection queue returned an invalid answer.');
    id = out;
  } catch (err) {
    throw fromUpstream(err);
  }

  // The GPU needs ~0.2 s and the worker polls every ~0.12 s: the first look can wait a little.
  let gap = Math.min(pollMs * 2, 300);
  while (now() < deadline) {
    await sleep(gap);
    gap = pollMs;
    let row: JobRow | undefined;
    try {
      const rows = await admin.select<JobRow>(
        'detect_jobs',
        { id: `eq.${id}`, select: 'status,result,error', limit: '1' },
        { timeoutMs: Math.max(1000, Math.min(4000, deadline - now())) },
      );
      row = rows[0];
    } catch (err) {
      throw fromUpstream(err);
    }
    if (!row) throw new QueueError(502, 'The detection job disappeared before it was read.');
    if (row.status === 'done') {
      if (row.result === null || row.result === undefined) throw new QueueError(502, 'The GPU worker returned no result.');
      return row.result;
    }
    if (row.status === 'error') {
      throw new QueueError(502, typeof row.error === 'string' && row.error ? row.error.slice(0, 200) : 'The GPU worker could not read this frame.');
    }
  }

  // Give the frame up so the worker does not spend the GPU on a viewer who has left.
  await admin
    .update('detect_jobs', { status: 'error', error: 'timed out', frame_b64: null }, { id })
    .catch(() => undefined);
  throw new QueueError(504, `The GPU did not answer within ${waitMs} ms.`);
}

export interface WorkerStatus {
  online: boolean;
  version: string | null;
  seenSecondsAgo: number | null;
  jobsDone: number | null;
}

/** Is a GPU worker alive? (for /api/health). Throws QueueError. */
export async function readWorkerStatus(admin: SupabaseAdmin): Promise<WorkerStatus> {
  try {
    const out = await admin.rpc<unknown>('detect_worker_status', {}, { timeoutMs: 4000 });
    const row = Array.isArray(out) ? (out[0] as Record<string, unknown> | undefined) : undefined;
    if (!row) return { online: false, version: null, seenSecondsAgo: null, jobsDone: null };
    return {
      online: row.online === true,
      version: typeof row.version === 'string' ? row.version : null,
      seenSecondsAgo: typeof row.seen_seconds_ago === 'number' ? row.seen_seconds_ago : Number.isFinite(Number(row.seen_seconds_ago)) ? Number(row.seen_seconds_ago) : null,
      jobsDone: typeof row.jobs_done === 'number' ? row.jobs_done : Number.isFinite(Number(row.jobs_done)) ? Number(row.jobs_done) : null,
    };
  } catch (err) {
    throw fromUpstream(err);
  }
}
