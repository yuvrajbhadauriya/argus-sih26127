import { describe, it, expect } from 'vitest';
import {
  engineView, engineLabel, formatAgo, formatUptime, heartbeatAt, parseModelStatusRow, remainingSeconds,
  STALE_AFTER_MS, type ModelStatusRow,
} from './status';

const NOW = Date.parse('2026-09-30T16:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const on = { configured: true, loaded: true };

function row(p: Partial<ModelStatusRow> = {}): ModelStatusRow {
  return {
    id: 'gpu-primary', state: 'running', eta_seconds: null, message: null, model_label: 'AI ANPR engine',
    restarts: 1, uptime_seconds: 3600, gpu_busy: false, started_at: iso(3_600_000), last_heartbeat: iso(2000), ...p,
  };
}

describe('engineView — state mapping', () => {
  it('running with a fresh heartbeat → online (green) with live uptime', () => {
    const v = engineView(row(), NOW, on);
    expect(v).toMatchObject({ kind: 'online', tone: 'success', label: 'AI engine online' });
    expect(v.uptimeSeconds).toBe(3602);
  });

  it('heartbeat exactly at the 30 s limit is still online; older is reconnecting', () => {
    expect(engineView(row({ last_heartbeat: iso(STALE_AFTER_MS) }), NOW, on).kind).toBe('online');
    const v = engineView(row({ last_heartbeat: iso(STALE_AFTER_MS + 1000) }), NOW, on);
    expect(v).toMatchObject({ kind: 'reconnecting', tone: 'danger', label: 'AI engine reconnecting…' });
    expect(v.lastSeenAt).toBe(NOW - STALE_AFTER_MS - 1000);
  });

  it('state down → reconnecting even with a fresh heartbeat', () => {
    expect(engineView(row({ state: 'down' }), NOW, on).kind).toBe('reconnecting');
  });

  it('starting / restarting → amber countdown', () => {
    for (const state of ['starting', 'restarting'] as const) {
      const v = engineView(row({ state, eta_seconds: 45, last_heartbeat: iso(0) }), NOW, on);
      expect(v).toMatchObject({ kind: 'starting', tone: 'warning', label: 'Model starting in 45s', remainingSeconds: 45 });
    }
  });

  it('a stale "starting" row is reconnecting', () => {
    expect(engineView(row({ state: 'starting', eta_seconds: 60, last_heartbeat: iso(40_000) }), NOW, on).kind).toBe('reconnecting');
  });

  it('no row: loading before the first fetch, reconnecting after', () => {
    expect(engineView(null, NOW, { configured: true, loaded: false }).kind).toBe('loading');
    expect(engineView(null, NOW, on)).toMatchObject({ kind: 'reconnecting', lastSeenAt: null });
  });

  it('not configured → demo', () => {
    expect(engineView(row(), NOW, { configured: false, loaded: true })).toMatchObject({ kind: 'demo', label: 'AI engine (demo)' });
  });
});

describe('countdown', () => {
  const r = row({ state: 'starting', eta_seconds: 10, last_heartbeat: iso(0) });

  it('decrements once per second from the heartbeat', () => {
    expect(remainingSeconds(r, NOW)).toBe(10);
    expect(remainingSeconds(r, NOW + 1000)).toBe(9);
    expect(remainingSeconds(r, NOW + 1500)).toBe(9);
    expect(remainingSeconds(r, NOW + 9000)).toBe(1);
    expect(engineView(r, NOW + 3000, on).label).toBe('Model starting in 7s');
  });

  it('clamps at 0 and then reads "Model starting…"', () => {
    expect(remainingSeconds(r, NOW + 10_000)).toBe(0);
    expect(remainingSeconds(r, NOW + 25_000)).toBe(0);
    const v = engineView(r, NOW + 12_000, on);
    expect(v.label).toBe('Model starting…');
    expect(v.remainingSeconds).toBe(0);
  });

  it('no ETA → "Model starting…"', () => {
    expect(engineView(row({ state: 'restarting', eta_seconds: null, last_heartbeat: iso(0) }), NOW, on).label).toBe('Model starting…');
  });

  it('a heartbeat from the future (clock skew) does not extend the countdown', () => {
    const future = row({ state: 'starting', eta_seconds: 20, last_heartbeat: new Date(NOW + 5000).toISOString() });
    expect(remainingSeconds(future, NOW)).toBe(20);
    expect(heartbeatAt(future, NOW)).toBe(NOW);
  });

  it('uses updated_at when it is newer than last_heartbeat', () => {
    const r2 = row({ state: 'starting', eta_seconds: 30, last_heartbeat: iso(40_000), updated_at: iso(5000) });
    expect(remainingSeconds(r2, NOW)).toBe(25);
    expect(engineView(r2, NOW, on).kind).toBe('starting');
  });
});

describe('labels never expose the architecture', () => {
  it('falls back to the generic name', () => {
    expect(engineLabel({ model_label: 'deim50k+raw35' })).toBe('AI ANPR engine');
    expect(engineLabel({ model_label: 'DEIM + PARSeq' })).toBe('AI ANPR engine');
    expect(engineLabel({ model_label: null })).toBe('AI ANPR engine');
    expect(engineLabel({ model_label: 'Plate engine A' })).toBe('Plate engine A');
  });

  it('scrubs names out of messages', () => {
    expect(engineView(row({ message: 'loading deim50k weights' }), NOW, on).message).not.toMatch(/deim/i);
  });
});

describe('parseModelStatusRow', () => {
  it('normalises unknown states and missing fields', () => {
    const r = parseModelStatusRow({ id: 'gpu-primary', state: 'weird', last_heartbeat: iso(0) });
    expect(r).toMatchObject({ state: 'down', restarts: 0, uptime_seconds: 0, gpu_busy: false, eta_seconds: null });
  });
  it('rejects rows without a heartbeat', () => {
    expect(parseModelStatusRow({ id: 'x' })).toBeNull();
    expect(parseModelStatusRow(null)).toBeNull();
  });
});

describe('formatters', () => {
  it('formats uptime and ago', () => {
    expect(formatUptime(42)).toBe('42s');
    expect(formatUptime(245)).toBe('4m 05s');
    expect(formatUptime(3 * 3600 + 12 * 60)).toBe('3h 12m');
    expect(formatUptime(2 * 86400 + 3600)).toBe('2d 1h');
    expect(formatAgo(NOW - 2000, NOW)).toBe('just now');
    expect(formatAgo(NOW - 45_000, NOW)).toBe('45 s ago');
    expect(formatAgo(NOW - 3 * 60_000, NOW)).toBe('3 min ago');
  });
});

describe('engineDetail', () => {
  it('describes each state', async () => {
    const { engineDetail } = await import('./status');
    expect(engineDetail(engineView(row({ uptime_seconds: 60, last_heartbeat: iso(0) }), NOW, on))).toBe('Up 1m 00s');
    expect(engineDetail(engineView(row({ last_heartbeat: iso(45_000) }), NOW, on))).toBe('Last seen 45 s ago');
    expect(engineDetail(engineView(null, NOW, on))).toBe('No heartbeat from the GPU server yet');
  });
});
