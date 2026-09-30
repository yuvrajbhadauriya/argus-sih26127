import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup } from '@testing-library/react';

const h = vi.hoisted(() => ({
  configured: true,
  row: null as Record<string, unknown> | null,
  error: null as string | null,
  fetches: 0,
}));

vi.mock('@/lib/supabase/client', () => ({
  getSupabase: async () => {
    throw new Error('the browser must not query tables directly');
  },
  isSupabaseConfigured: () => h.configured,
  getAccessToken: async () => null,
}));

/** GET /api/data/model-status → { row } (or a 502 { error }). */
const fetchStub = vi.fn(async (url: RequestInfo | URL) => {
  if (!String(url).startsWith('/api/data/model-status')) return new Response('not found', { status: 404 });
  h.fetches++;
  return h.error
    ? new Response(JSON.stringify({ error: h.error }), { status: 502 })
    : new Response(JSON.stringify({ row: h.row }), { status: 200 });
});

import { AiEngineStatusPill } from './AiEngineStatus';
import { resetAiEngineStore } from '../hooks/useAiEngineStatus';

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-09-30T16:00:00Z'));
  h.configured = true;
  h.row = null;
  h.error = null;
  h.fetches = 0;
  vi.stubGlobal('fetch', fetchStub);
  resetAiEngineStore();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

describe('AiEngineStatusPill', () => {
  it('shows "AI engine online" for a running engine', async () => {
    h.row = { id: 'gpu-primary', state: 'running', last_heartbeat: at(1000), uptime_seconds: 120, model_label: 'AI ANPR engine' };
    render(<AiEngineStatusPill variant="panel" />);
    await flush();
    expect(screen.getByText('AI engine online')).toBeInTheDocument();
    expect(screen.getByText(/Up 2m/)).toBeInTheDocument();
  });

  it('counts down locally while starting, then "Model starting…"', async () => {
    h.row = { id: 'gpu-primary', state: 'starting', eta_seconds: 3, last_heartbeat: at(0) };
    render(<AiEngineStatusPill variant="panel" />);
    await flush();
    expect(screen.getByText('Model starting in 3s')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText('Model starting in 2s')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByText('Model starting…')).toBeInTheDocument();
  });

  it('picks up a state change on the next 5 s poll', async () => {
    h.row = { id: 'gpu-primary', state: 'starting', eta_seconds: 30, last_heartbeat: at(0) };
    render(<AiEngineStatusPill variant="panel" />);
    await flush();
    expect(screen.getByText(/Model starting/)).toBeInTheDocument();
    h.row = { id: 'gpu-primary', state: 'running', last_heartbeat: new Date(Date.now() + 5000).toISOString(), uptime_seconds: 5 };
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    await flush();
    expect(screen.getByText('AI engine online')).toBeInTheDocument();
  });

  it('goes to "reconnecting" when the heartbeat stops, and polls every 5 s', async () => {
    h.row = { id: 'gpu-primary', state: 'running', last_heartbeat: at(0), uptime_seconds: 5 };
    render(<AiEngineStatusPill variant="panel" />);
    await flush();
    expect(screen.getByText('AI engine online')).toBeInTheDocument();
    const before = h.fetches;
    // Watchdog dies: the row stops changing.
    for (let i = 0; i < 7; i++) {
      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });
      await flush();
    }
    expect(screen.getByText('AI engine reconnecting…')).toBeInTheDocument();
    expect(screen.getByText(/Last seen/)).toBeInTheDocument();
    expect(h.fetches - before).toBeGreaterThanOrEqual(6);
  });

  it('an empty table or an API error shows reconnecting without logging', async () => {
    const err = vi.spyOn(console, 'error');
    const warn = vi.spyOn(console, 'warn');
    h.error = 'Database request failed (HTTP 500)';
    render(<AiEngineStatusPill variant="panel" />);
    await flush();
    expect(screen.getByText('AI engine reconnecting…')).toBeInTheDocument();
    expect(err).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('never shows the architecture name', async () => {
    h.row = { id: 'gpu-primary', state: 'running', last_heartbeat: at(0), model_label: 'deim50k+raw35' };
    const { container } = render(<AiEngineStatusPill variant="panel" />);
    await flush();
    expect(container.textContent).not.toMatch(/deim|parseq|raw35/i);
    expect(container.textContent).toMatch(/AI ANPR engine/);
  });

  it('compact variant renders nothing without a database; panel says demo', async () => {
    h.configured = false;
    const { container, unmount } = render(<AiEngineStatusPill />);
    await flush();
    expect(container).toBeEmptyDOMElement();
    unmount();
    render(<AiEngineStatusPill variant="panel" />);
    expect(screen.getByText('AI engine (demo)')).toBeInTheDocument();
    expect(h.fetches).toBe(0);
  });

  it('stops the feed when the last consumer unmounts', async () => {
    h.row = { id: 'gpu-primary', state: 'running', last_heartbeat: at(0) };
    const a = render(<AiEngineStatusPill variant="panel" />);
    const b = render(<AiEngineStatusPill />);
    await flush();
    const fetchesWithTwo = h.fetches;
    expect(fetchesWithTwo).toBe(1); // one shared feed
    a.unmount();
    b.unmount();
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(h.fetches).toBe(fetchesWithTwo);
  });
});
