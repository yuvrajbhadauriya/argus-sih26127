// ═══════════════════════════════════════════════════
// AI engine status — pure mapping from the `model_status` heartbeat row
// (supabase/migrations/20261001000500_model_status.sql) to what the top bar
// and the Cameras page show. No React, no Supabase: fully unit-tested.
//
//   running + heartbeat ≤ 30 s old   → "AI engine online"          (green)
//   starting / restarting            → "Model starting in {n}s"    (amber)
//                                      countdown runs locally from the
//                                      heartbeat; at 0 → "Model starting…"
//   heartbeat > 30 s old, down, none → "AI engine reconnecting…"   (red)
//   Supabase not configured          → "AI engine (demo)"          (neutral)
//
// Never surfaces the model architecture: the label is the row's
// `model_label` (e.g. "AI ANPR engine") or that generic default.
// ═══════════════════════════════════════════════════

export type EngineState = 'running' | 'starting' | 'restarting' | 'down';

export interface ModelStatusRow {
  id: string;
  state: EngineState;
  eta_seconds: number | null;
  message: string | null;
  model_label: string | null;
  restarts: number;
  uptime_seconds: number;
  gpu_busy: boolean;
  started_at: string | null;
  last_heartbeat: string;
  updated_at?: string | null;
}

/** A heartbeat older than this means the watchdog (or the box) is gone. */
export const STALE_AFTER_MS = 30_000;
export const DEFAULT_ENGINE_LABEL = 'AI ANPR engine';

export type EngineKind = 'demo' | 'loading' | 'online' | 'starting' | 'reconnecting';
export type EngineTone = 'neutral' | 'success' | 'warning' | 'danger';

export interface EngineView {
  kind: EngineKind;
  tone: EngineTone;
  /** Short status text for the pill. */
  label: string;
  /** Generic engine name (never an architecture name). */
  engineLabel: string;
  /** Seconds left while starting (null otherwise, or when no ETA was given). */
  remainingSeconds: number | null;
  /** Epoch ms of the last heartbeat, when known. */
  lastSeenAt: number | null;
  /** Live uptime in seconds while online. */
  uptimeSeconds: number | null;
  restarts: number | null;
  gpuBusy: boolean | null;
  message: string | null;
  /** The instant this view was computed for (epoch ms). */
  now: number;
}

const KNOWN_STATES = new Set<EngineState>(['running', 'starting', 'restarting', 'down']);

/** Architecture / checkpoint names that must never reach the UI. */
const ARCH_NAME = /deim|parseq|yolo|raw35|deim50k|lpu_on_gpu/i;

/** Normalise a raw row (Realtime payloads are untyped). Returns null when unusable. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseModelStatusRow(raw: any): ModelStatusRow | null {
  if (!raw || typeof raw !== 'object' || typeof raw.last_heartbeat !== 'string') return null;
  const state: EngineState = KNOWN_STATES.has(raw.state) ? raw.state : 'down';
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    id: String(raw.id ?? ''),
    state,
    eta_seconds: num(raw.eta_seconds),
    message: typeof raw.message === 'string' && raw.message.trim() ? raw.message : null,
    model_label: typeof raw.model_label === 'string' ? raw.model_label : null,
    restarts: num(raw.restarts) ?? 0,
    uptime_seconds: num(raw.uptime_seconds) ?? 0,
    gpu_busy: raw.gpu_busy === true,
    started_at: typeof raw.started_at === 'string' ? raw.started_at : null,
    last_heartbeat: raw.last_heartbeat,
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : null,
  };
}

/** Generic engine name for display — falls back when the label names an architecture. */
export function engineLabel(row: Pick<ModelStatusRow, 'model_label'> | null): string {
  const l = row?.model_label?.trim();
  return l && !ARCH_NAME.test(l) ? l : DEFAULT_ENGINE_LABEL;
}

function safeMessage(msg: string | null): string | null {
  if (!msg) return null;
  return msg.replace(/\b(deim50k|deim|parseq|raw35|yolo\w*)\b/gi, 'model').trim() || null;
}

/** Epoch ms of the latest sign of life (heartbeat or row update), clamped to `now` (clock skew). */
export function heartbeatAt(row: Pick<ModelStatusRow, 'last_heartbeat' | 'updated_at'>, now: number): number | null {
  const hb = Date.parse(row.last_heartbeat);
  const up = row.updated_at ? Date.parse(row.updated_at) : NaN;
  const t = Math.max(Number.isFinite(hb) ? hb : -Infinity, Number.isFinite(up) ? up : -Infinity);
  if (!Number.isFinite(t)) return null;
  return Math.min(t, now);
}

/**
 * Seconds left of the start-up countdown at `now`: eta_seconds counted down
 * from the heartbeat that reported it, rounded up and clamped at 0.
 */
export function remainingSeconds(row: Pick<ModelStatusRow, 'eta_seconds' | 'last_heartbeat' | 'updated_at'>, now: number): number | null {
  if (row.eta_seconds == null) return null;
  const at = heartbeatAt(row, now);
  if (at == null) return row.eta_seconds;
  const left = row.eta_seconds - (now - at) / 1000;
  return Math.max(0, Math.ceil(left - 1e-9));
}

export interface EngineViewOptions {
  /** Supabase configured? When false the engine is not reachable from this build. */
  configured: boolean;
  /** Whether a first fetch has finished (distinguishes "loading" from "no row"). */
  loaded: boolean;
}

export function engineView(row: ModelStatusRow | null, now: number, opts: EngineViewOptions): EngineView {
  const base = {
    engineLabel: engineLabel(row),
    remainingSeconds: null,
    lastSeenAt: null,
    uptimeSeconds: null,
    restarts: row?.restarts ?? null,
    gpuBusy: row ? row.gpu_busy : null,
    message: safeMessage(row?.message ?? null),
    now,
  };
  if (!opts.configured) return { ...base, kind: 'demo', tone: 'neutral', label: 'AI engine (demo)' };
  if (!row) {
    if (!opts.loaded) return { ...base, kind: 'loading', tone: 'neutral', label: 'AI engine…' };
    return { ...base, kind: 'reconnecting', tone: 'danger', label: 'AI engine reconnecting…' };
  }

  const at = heartbeatAt(row, now);
  const stale = at == null || now - at > STALE_AFTER_MS;
  const lastSeenAt = at;

  if (stale || row.state === 'down') {
    return { ...base, lastSeenAt, kind: 'reconnecting', tone: 'danger', label: 'AI engine reconnecting…' };
  }
  if (row.state === 'starting' || row.state === 'restarting') {
    const left = remainingSeconds(row, now);
    const label = left != null && left > 0 ? `Model starting in ${left}s` : 'Model starting…';
    return { ...base, lastSeenAt, remainingSeconds: left, kind: 'starting', tone: 'warning', label };
  }
  const uptime = row.uptime_seconds + Math.max(0, Math.floor((now - (at ?? now)) / 1000));
  return { ...base, lastSeenAt, uptimeSeconds: uptime, kind: 'online', tone: 'success', label: 'AI engine online' };
}

/** "3h 12m", "4m 05s", "42s". */
export function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

/** "just now", "45 s ago", "3 min ago", "2 h ago". */
export function formatAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/** One-line detail under the status: uptime / last seen / start-up context. */
export function engineDetail(v: EngineView): string {
  switch (v.kind) {
    case 'online':
      return v.uptimeSeconds != null ? `Up ${formatUptime(v.uptimeSeconds)}${v.gpuBusy ? ' · GPU busy' : ''}` : 'Running';
    case 'starting':
      return v.message ?? 'Loading the model on the GPU server';
    case 'reconnecting':
      return v.lastSeenAt != null ? `Last seen ${formatAgo(v.lastSeenAt, v.now)}` : 'No heartbeat from the GPU server yet';
    case 'demo':
      return 'Demo build — no GPU server connected';
    default:
      return 'Checking…';
  }
}
