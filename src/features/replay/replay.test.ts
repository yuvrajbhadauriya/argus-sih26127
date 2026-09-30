import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getReplayClock, getReplayState, istOnDay, pauseReplay, resetReplay, resumeReplay, seekReplay, setReplaySpeed, startReplay, stopReplay,
  formatReplayClock, REPLAY_TICK_MS,
} from './clock';
import { alertsFiredBetween, feedAt, readsInWindow, resetReplayEngine, startReplayEngine } from './engine';
import { subscribeAlertEvents, type AlertEvent } from '@/features/alerts/live';
import { mockAlertFeed } from '@/mocks/fixtures/mockAlerts';

beforeEach(() => {
  vi.useFakeTimers();
  resetReplay();
  resetReplayEngine();
});
afterEach(() => {
  resetReplay();
  vi.useRealTimers();
});

describe('replay clock', () => {
  it('is off by default (whole day shown)', () => {
    expect(getReplayClock()).toBeNull();
  });

  it('advances at the chosen speed and can pause / resume / stop', () => {
    startReplay('08:00:00', 60);
    expect(getReplayClock()).toBe(istOnDay('08:00:00'));
    vi.advanceTimersByTime(1000); // 1 s real = 60 s simulated
    expect(formatReplayClock(getReplayClock()!)).toBe('08:01:00');
    pauseReplay();
    vi.advanceTimersByTime(5000);
    expect(formatReplayClock(getReplayClock()!)).toBe('08:01:00');
    setReplaySpeed(600);
    resumeReplay();
    vi.advanceTimersByTime(1000);
    expect(formatReplayClock(getReplayClock()!)).toBe('08:11:00');
    stopReplay();
    expect(getReplayClock()).toBeNull();
  });

  it('seeks within the simulated day', () => {
    startReplay();
    seekReplay('21:00:00');
    expect(formatReplayClock(getReplayClock()!)).toBe('21:00:00');
    seekReplay(0);
    expect(formatReplayClock(getReplayClock()!)).toBe('00:00:00');
  });

  it('stops at the end of the day', () => {
    startReplay('23:59:00', 600);
    vi.advanceTimersByTime(REPLAY_TICK_MS * 8);
    expect(getReplayState().playing).toBe(false);
    expect(formatReplayClock(getReplayClock()!)).toBe('23:59:59');
  });
});

describe('replay engine', () => {
  it('lists the alerts that fire in a window, oldest first', () => {
    const all = alertsFiredBetween(0, Number.MAX_SAFE_INTEGER);
    expect(all).toHaveLength(mockAlertFeed.length);
    const times = all.map((a) => Date.parse(a.timestamp));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    const first = times[0];
    expect(alertsFiredBetween(first - 1, first).map((a) => a.id)).toEqual([all[0].id]);
  });

  it('emits each alert once as the clock passes it — never for seeks', () => {
    const events: AlertEvent[] = [];
    const off = subscribeAlertEvents((e) => events.push(e));
    const stop = startReplayEngine();
    const firstAt = Math.min(...mockAlertFeed.map((a) => Date.parse(a.timestamp)));
    startReplay(formatReplayClock(firstAt - 30_000), 60);
    vi.advanceTimersByTime(1000); // passes the first alert
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]).toMatchObject({ type: 'insert', source: 'replay' });
    expect(events[0].alert.acknowledged).toBe(false);
    const n = events.length;
    seekReplay('23:00:00'); // jumping over the day fires nothing
    expect(events.length).toBe(n);
    stop();
    off();
  });

  it('builds the live feed and hourly read counts at the replay clock', () => {
    const t0 = istOnDay('08:00:00');
    const rows = [
      { t: t0 - 7_200_000, plate: 'MH 01 AA 0001', camera: 'VP-01', vehicleType: 'car' as const, id: 'a' },
      { t: t0 - 60_000, plate: 'MH 01 CS 0126', camera: 'SC-01', vehicleType: 'car' as const, id: 'b' },
      { t: t0, plate: 'MH 02 BB 0002', camera: 'DD-01', vehicleType: 'bus' as const, id: 'c' },
      { t: t0 + 1000, plate: 'MH 03 CC 0003', camera: 'AN-01', vehicleType: 'car' as const, id: 'd' },
    ];
    const feed = feedAt(rows, t0, 5);
    expect(feed.map((f) => f.id)).toEqual(['c', 'b', 'a']);
    expect(feed[1]).toMatchObject({ secondsAgo: 60, watchlist: 'critical', cameraCode: 'SC-01' });
    expect(feed[0].confidence).toBeGreaterThanOrEqual(86);
    expect(readsInWindow(rows, t0)).toBe(2);
  });
});
