// ═══════════════════════════════════════════════════
// useLiveAnpr — real-time ANPR on the playing feed.
//
// While the feed plays, the current frame is captured, sent through the
// same-origin proxy (/api/detect, which holds the model API key) to the GPU
// ANPR model, and every good read comes back with its plate box. The plate is
// cropped from that same frame, so the panel shows the real region the model
// read.
//
// The GPU is shared (one request at a time): requests never overlap, start at
// most every `intervalMs`, and only run while the video is actually playing in
// a visible tab. When the GPU cannot be reached (the model API is LAN/VPN-only
// and, on the hosted site, the GPU worker behind the Supabase queue is down) the
// status is 'unavailable' and the hook keeps retrying slowly, so it recovers by
// itself when the GPU box comes back.
// ═══════════════════════════════════════════════════

import { useEffect, useState } from 'react';
import {
  captureVideoFrameWithCanvas,
  detectCapturedFrame,
  DetectFrameError,
} from '../remote/detectFrame';
import { candidatesFromResponse, mergeReads, type LivePlateRead } from '../remote/liveAnpr';

/** Minimum gap between two request starts. */
export const LIVE_ANPR_INTERVAL_MS = 1000;
const IDLE_POLL_MS = 400;
const RETRY_BASE_MS = 3000;
const RETRY_MAX_MS = 30_000;
/** Not configured / route missing / pixels unreadable: retrying soon will not help. */
const RETRY_PERMANENT_MS = 60_000;

export type LiveAnprStatus = 'off' | 'connecting' | 'live' | 'unavailable';

export interface LiveAnprState {
  status: LiveAnprStatus;
  /** Newest first. */
  reads: LivePlateRead[];
  /** Frames the model has analysed since the feed started. */
  frames: number;
  /** Round trip of the last analysed frame (ms). */
  latencyMs: number | null;
  modelVersion: string | null;
  /** Why the status is 'unavailable'. */
  reason: string | null;
}

const OFF: LiveAnprState = { status: 'off', reads: [], frames: 0, latencyMs: null, modelVersion: null, reason: null };
const CONNECTING: LiveAnprState = { ...OFF, status: 'connecting' };

export interface LiveAnprOptions {
  intervalMs?: number;
  endpoint?: string;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

function retryDelay(failures: number, err: unknown): number {
  if (err instanceof DetectFrameError) {
    if (err.code === 'tainted' || err.code === 'encode') return RETRY_PERMANENT_MS;
    if (err.code === 'http' && (err.status === 503 || err.status === 404)) return RETRY_PERMANENT_MS;
  }
  return Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS);
}

const analysable = (v: HTMLVideoElement) =>
  !v.paused && !v.ended && v.readyState >= 2 && v.videoWidth > 0 && document.visibilityState !== 'hidden';

/** `video` null (not playing yet / offline) switches the loop off and clears the rows. */
export function useLiveAnpr(video: HTMLVideoElement | null, cameraCode: string, options: LiveAnprOptions = {}): LiveAnprState {
  const { intervalMs = LIVE_ANPR_INTERVAL_MS, endpoint } = options;
  // The state belongs to one (video, camera): anything else reads as off / connecting without an effect-time reset.
  const [owned, setOwned] = useState<{ video: HTMLVideoElement; camera: string; data: LiveAnprState } | null>(null);

  useEffect(() => {
    if (!video) return;
    const ctl = new AbortController();
    const { signal } = ctl;
    let data = CONNECTING;
    let reads: LivePlateRead[] = [];
    let frames = 0;
    let failures = 0;
    const publish = (patch: Partial<LiveAnprState>) => {
      data = { ...data, ...patch };
      setOwned({ video, camera: cameraCode, data });
    };

    const loop = async () => {
      while (!signal.aborted) {
        if (!analysable(video)) {
          await sleep(IDLE_POLL_MS, signal);
          continue;
        }
        const started = performance.now();
        try {
          const frame = captureVideoFrameWithCanvas(video);
          const res = await detectCapturedFrame(frame, { cameraCode, signal, endpoint });
          if (signal.aborted) return;
          failures = 0;
          frames += 1;
          reads = mergeReads(reads, candidatesFromResponse(res, frame.canvas, frame.timestampSec), Date.now(), cameraCode);
          publish({ status: 'live', reads, frames, latencyMs: res.latency_ms, modelVersion: res.model_version, reason: null });
        } catch (err) {
          if (signal.aborted || (err instanceof DetectFrameError && err.code === 'aborted')) return;
          failures += 1;
          publish({ status: 'unavailable', reason: err instanceof Error ? err.message : 'Live detection failed' });
          await sleep(retryDelay(failures, err), signal);
          continue;
        }
        await sleep(Math.max(0, intervalMs - (performance.now() - started)), signal);
      }
    };
    void loop();
    return () => ctl.abort();
  }, [video, cameraCode, intervalMs, endpoint]);

  if (!video) return OFF;
  return owned && owned.video === video && owned.camera === cameraCode ? owned.data : CONNECTING;
}
