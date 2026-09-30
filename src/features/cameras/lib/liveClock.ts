// ═══════════════════════════════════════════════════
// Virtual live clock — makes looping demo clips behave like continuous CCTV.
//
// Every camera's clip runs on a wall clock that never pauses:
//   position = ((now − EPOCH) / 1000 + perCameraOffset) mod clipDuration
// so pausing, switching camera, reloading or coming back to the tab always
// lands on "what the camera is showing right now" instead of restarting at 0.
// The offset is a deterministic hash of the camera code, so cameras are not
// in lock-step and nothing needs to be persisted.
// ═══════════════════════════════════════════════════

/** Fixed origin of the virtual clock (2026-01-01T00:00:00Z). */
export const LIVE_CLOCK_EPOCH_MS = Date.UTC(2026, 0, 1);

/** Offsets are spread over this many seconds (longer than any clip). */
const OFFSET_SPAN_SEC = 3600;

/** A playing feed that drifts further than this from the clock is re-seeked. */
export const LIVE_DRIFT_TOLERANCE_SEC = 1.5;

/** Deterministic per-camera offset in [0, 3600) seconds (FNV-1a hash of the code). */
export function cameraClockOffset(code: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % (OFFSET_SPAN_SEC * 1000)) / 1000;
}

/** Seconds on the camera's virtual clock (monotonic, not wrapped). */
export function liveClockSeconds(code: string, nowMs: number = Date.now()): number {
  return (nowMs - LIVE_CLOCK_EPOCH_MS) / 1000 + cameraClockOffset(code);
}

/** Where the clip should be right now; 0 when the duration is unknown. */
export function livePosition(code: string, durationSec: number, nowMs: number = Date.now()): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  const t = liveClockSeconds(code, nowMs) % durationSec;
  return t < 0 ? t + durationSec : t;
}

/** Signed shortest distance from `current` to `target` on a loop of `duration` (wrap-aware). */
export function loopDelta(current: number, target: number, duration: number): number {
  if (!(duration > 0)) return target - current;
  let d = (target - current) % duration;
  if (d > duration / 2) d -= duration;
  else if (d < -duration / 2) d += duration;
  return d;
}

/**
 * Seek `video` to the camera's live position when it is off by more than
 * `tolerance` seconds. `clockDuration` is the camera's canonical clip length
 * (from the ANPR events file) so the video, its detection overlay and the
 * live plate-read list all loop on exactly the same clock; it defaults to the
 * element's own duration. Returns true when a seek was issued. Safe to call
 * before metadata is loaded (does nothing until the duration is known).
 */
export function syncVideoToLiveClock(
  video: Pick<HTMLVideoElement, 'duration' | 'currentTime' | 'readyState'>,
  code: string,
  tolerance: number = LIVE_DRIFT_TOLERANCE_SEC,
  nowMs: number = Date.now(),
  clockDuration?: number | null,
): boolean {
  const mediaDur = video.duration;
  if (!Number.isFinite(mediaDur) || mediaDur <= 0 || video.readyState < 1) return false;
  const dur = clockDuration && clockDuration > 0 ? clockDuration : mediaDur;
  // Never seek past the media's own end (the two durations can differ by a frame or two).
  const target = Math.min(livePosition(code, dur, nowMs), Math.max(0, mediaDur - 0.05));
  if (Math.abs(loopDelta(video.currentTime, target, dur)) <= tolerance) return false;
  try {
    video.currentTime = target;
    return true;
  } catch {
    return false;
  }
}
