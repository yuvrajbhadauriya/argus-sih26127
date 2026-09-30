// ═══════════════════════════════════════════════════
// Replay clock — "replay the day" for the simulated network.
//
// A module-level store (no React Provider), so the replay keeps running while
// the operator moves between Live Map and Alerts. Deliberately dependency-free:
// data modules (alerts api) read getReplayClock() without pulling in the
// engine. The engine (./engine.ts) subscribes and turns clock ticks into
// sightings + alert events.
// ═══════════════════════════════════════════════════

import { useSyncExternalStore } from 'react';

/** Simulated day (IST) — matches public/sim/summary.json `date`. */
export const REPLAY_DATE = '2026-09-29';
export const REPLAY_TZ = '+05:30';
/** Replay starts just before the stolen car MH 01 CS 0126 is read at JG-01 (08:05 IST). */
export const REPLAY_DEFAULT_START = '07:58:00';
export const REPLAY_SPEEDS = [30, 60, 120, 300, 600] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];
/** Real-time tick interval. */
export const REPLAY_TICK_MS = 250;

export const dayStart = () => Date.parse(`${REPLAY_DATE}T00:00:00${REPLAY_TZ}`);
export const dayEnd = () => Date.parse(`${REPLAY_DATE}T23:59:59${REPLAY_TZ}`);
export const istOnDay = (hms: string) => Date.parse(`${REPLAY_DATE}T${hms}${REPLAY_TZ}`);

const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

/** "HH:MM:SS" (IST) of a replay instant. */
export function formatReplayClock(ms: number): string {
  return fmt.format(new Date(ms));
}

export interface ReplayState {
  /** Replay mode on (clock drives the simulated data). */
  active: boolean;
  /** Clock advancing. */
  playing: boolean;
  /** Current replay time (epoch ms). */
  clock: number;
  /** Simulated seconds per real second. */
  speed: ReplaySpeed;
}

let state: ReplayState = { active: false, playing: false, clock: istOnDay(REPLAY_DEFAULT_START), speed: 60 };
/** Why the state changed: a clock tick (fires events), a seek or a control change (never fire). */
export type ReplayChange = 'tick' | 'seek' | 'control';
type Listener = (prev: ReplayState, next: ReplayState, change: ReplayChange) => void;
const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | null = null;
let lastReal = 0;

function set(patch: Partial<ReplayState>, change: ReplayChange = 'control') {
  const prev = state;
  state = { ...state, ...patch };
  listeners.forEach((l) => l(prev, state, change));
}

function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

function tick() {
  const now = Date.now();
  const dt = now - lastReal;
  lastReal = now;
  const next = Math.min(dayEnd(), state.clock + dt * state.speed);
  if (next >= dayEnd()) {
    stopTimer();
    set({ clock: next, playing: false }, 'tick');
  } else {
    set({ clock: next }, 'tick');
  }
}

function startTimer() {
  stopTimer();
  lastReal = Date.now();
  timer = setInterval(tick, REPLAY_TICK_MS);
}

/** Replay time in epoch ms while replay mode is on, else null (show the whole day). */
export function getReplayClock(): number | null {
  return state.active ? state.clock : null;
}

export function getReplayState(): ReplayState {
  return state;
}

/** Turn replay on at `from` (IST HH:MM:SS) and start playing. */
export function startReplay(from: string = REPLAY_DEFAULT_START, speed: ReplaySpeed = state.speed): void {
  set({ active: true, playing: true, clock: istOnDay(from), speed }, 'seek');
  startTimer();
}

export function pauseReplay(): void {
  stopTimer();
  set({ playing: false });
}

export function resumeReplay(): void {
  if (!state.active) return startReplay();
  if (state.clock >= dayEnd()) return;
  set({ playing: true });
  startTimer();
}

export function stopReplay(): void {
  stopTimer();
  set({ active: false, playing: false });
}

export function setReplaySpeed(speed: ReplaySpeed): void {
  set({ speed });
}

/** Jump the clock (IST HH:MM:SS or epoch ms). Jumps never fire alerts for the skipped span. */
export function seekReplay(to: string | number): void {
  const clock = typeof to === 'number' ? to : istOnDay(to);
  set({ clock: Math.max(dayStart(), Math.min(dayEnd(), clock)) }, 'seek');
}

/** Subscribe to every state change (receives previous + next state). */
export function subscribeReplay(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const snap = () => state;
const sub = (cb: () => void) => subscribeReplay(() => cb());

export function useReplay(): ReplayState {
  return useSyncExternalStore(sub, snap, snap);
}

/** Test hook. */
export function resetReplay(): void {
  stopTimer();
  state = { active: false, playing: false, clock: istOnDay(REPLAY_DEFAULT_START), speed: 60 };
  listeners.forEach((l) => l(state, state, 'control'));
}
