// ═══════════════════════════════════════════════════
// LiveDetectPanel
// "Run AI detection on this frame": captures the current frame of a camera
// <video>, sends it to /api/detect (trained YOLOv7-tiny ANPR model on the GPU
// server, key kept server-side), and shows the analysed still with boxes +
// plate text, plus a list of plates with confidence and latency.
// Self-contained — drop it next to any <video> ref.
// ═══════════════════════════════════════════════════

import { useEffect, useRef, useState, type RefObject } from 'react';
import { ScanLineIcon, LoaderCircleIcon, AlertTriangleIcon } from 'lucide-react';
import {
  detectVideoFrame,
  DetectFrameError,
  type CapturedFrame,
  type RemoteDetectResponse,
} from '../remote/detectFrame';
import { drawDetections, formatPct as pct } from '../remote/drawDetections';

interface LiveDetectPanelProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  cameraCode: string;
}

type Status = 'idle' | 'running' | 'done' | 'error';

export function LiveDetectPanel({ videoRef, cameraCode }: LiveDetectPanelProps) {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState<CapturedFrame | null>(null);
  const [result, setResult] = useState<RemoteDetectResponse | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Cancel an in-flight request when unmounting or switching camera.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, [cameraCode]);

  useEffect(() => {
    if (frame && result && overlayRef.current) {
      drawDetections(overlayRef.current, frame, result.detections);
    }
  }, [frame, result]);

  async function run() {
    const video = videoRef.current;
    if (!video) {
      setStatus('error');
      setError('No video element is attached.');
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus('running');
    setError(null);
    try {
      const { frame: f, result: r } = await detectVideoFrame(video, { cameraCode, signal: controller.signal });
      if (controller.signal.aborted) return;
      setFrame(f);
      setResult(r);
      setStatus('done');
    } catch (err) {
      if (err instanceof DetectFrameError && err.code === 'aborted') return;
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Detection failed.');
    }
  }

  const running = status === 'running';
  const plates = result?.detections ?? [];

  return (
    <div className="rounded-xl border border-nero-border bg-nero-surface p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-nero-text-primary">AI Plate Detection</h3>
          <p className="text-[11px] text-nero-text-muted">YOLOv7-tiny ANPR model · camera {cameraCode}</p>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={running}
          className="flex items-center gap-2 rounded-xl border border-nero-accent/40 bg-nero-accent/10 px-3 py-1.5 text-xs font-semibold text-nero-accent hover:bg-nero-accent/20 disabled:opacity-50 disabled:cursor-wait cursor-pointer transition-colors"
        >
          {running ? <LoaderCircleIcon size={14} className="animate-spin" /> : <ScanLineIcon size={14} />}
          {running ? 'Detecting…' : 'Run AI detection on this frame'}
        </button>
      </div>

      {status === 'error' && error && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          <AlertTriangleIcon size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {frame && result && (
        <>
          <div className="relative w-full overflow-hidden rounded-lg bg-black">
            <img src={frame.dataUrl} alt={`Analysed frame from ${cameraCode}`} className="block w-full h-auto" />
            <canvas ref={overlayRef} data-testid="detect-overlay" className="absolute inset-0 w-full h-full pointer-events-none" />
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-nero-text-muted">
            <span>Latency: <span className="font-semibold text-nero-text-secondary">{result.latency_ms} ms</span></span>
            {result.inference_ms != null && (
              <span>Inference: <span className="font-semibold text-nero-text-secondary">{result.inference_ms} ms</span></span>
            )}
            <span>Model: <span className="font-semibold text-nero-text-secondary">{result.engine} {result.model_version}</span></span>
            <span>Frame t={frame.timestampSec.toFixed(2)}s</span>
          </div>

          {plates.length === 0 ? (
            <p className="text-xs text-nero-text-muted">No vehicles or plates detected in this frame.</p>
          ) : (
            <ul className="divide-y divide-nero-border rounded-lg border border-nero-border">
              {plates.map((d, i) => (
                <li key={i} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                  <span className="font-mono text-sm font-black text-nero-accent">{d.plate_text ?? 'Plate unreadable'}</span>
                  <span className="flex items-center gap-3 text-nero-text-muted">
                    <span className="capitalize">{d.vehicle_type}</span>
                    <span>OCR {pct(d.plate_confidence)}</span>
                    <span>Det {pct(d.confidence)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
