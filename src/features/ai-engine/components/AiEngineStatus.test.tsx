import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup } from '@testing-library/react';

const h = vi.hoisted(() => ({
  configured: true,
  row: null as Record<string, unknown> | null,
  error: null as { message: string } | null,
  fetches: 0,
  handlers: [] as ((p: { new: unknown }) => void)[],
  removed: 0,
}));

vi.mock('@/lib/supabase/client', () => {
  const channel = {
    on: (_k: string, _f: unknown, cb: (p: { new: unknown }) => void) => {
      h.handlers.push(cb);
      return channel;
    },
    subscribe: () => channel,
  };
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: () => {
      h.fetches++;
      return Promise.resolve({ data: h.row, error: h.error });
    },
  };
  const client = {
    from: () => builder,
    channel: () => channel,
    removeChannel: () => {
      h.removed++;
      return Promise.resolve('ok');
    },
  };
  return { getSupabase: async () => client, isSupabaseConfigured: () => h.configured };
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
  h.handlers = [];
  h.removed = 0;
  resetAiEngineStore();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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

  it('applies Realtime updates immediately', async () => {
    h.row = { id: 'gpu-primary', state: 'starting', eta_seconds: 30, last_heartbeat: at(0) };
    render(<AiEngineStatusPill variant="panel" />);
    await flush();
    expect(h.handlers.length).toBeGreaterThan(0);
    act(() => h.handlers[0]({ new: { id: 'gpu-primary', state: 'running', last_heartbeat: new Date().toISOString(), uptime_seconds: 5 } }));
    expect(screen.getByText('AI engine online')).toBeInTheDocument();
  });

  it('goes to "reconnecting" when the heartbeat stops, and polls every 10 s', async () => {
    h.row = { id: 'gpu-primary', state: 'running', last_heartbeat: at(0), uptime_seconds: 5 };
    render(<AiEngineStatusPill variant="panel" />);
    await flush();
    expect(screen.getByText('AI engine online')).toBeInTheDocument();
    const before = h.fetches;
    // Watchdog dies: the row stops changing.
    await act(async () => {
      vi.advanceTimersByTime(31_000);
    });
    await flush();
    expect(screen.getByText('AI engine reconnecting…')).toBeInTheDocument();
    expect(screen.getByText(/Last seen/)).toBeInTheDocument();
    expect(h.fetches - before).toBeGreaterThanOrEqual(3);
  });

  it('an empty table or a query error shows reconnecting without logging', async () => {
    const err = vi.spyOn(console, 'error');
    const warn = vi.spyOn(console, 'warn');
    h.error = { message: 'permission denied' };
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
    expect(h.removed).toBe(1);
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(h.fetches).toBe(fetchesWithTwo);
  });
});
