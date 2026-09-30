// ═══════════════════════════════════════════════════
// LiveDetectPanel
// "Run AI detection on this frame": captures the current frame of a camera
// <video>, sends it to /api/detect (trained YOLOv7-tiny ANPR model on the GPU
// server, key kept server-side), and shows the analysed still with boxes +
// plate text, plus a list of plates with confidence and latency.
// Panel-body content: the caller supplies the surrounding Panel/title.
// ═══════════════════════════════════════════════════

import { useEffect, useRef, useState, type RefObject } from 'react';
import { ScanLineIcon, TriangleAlertIcon } from 'lucide-react';
import { Button } from '@/shared/ui/Button';
import { PlateChip } from '@/shared/ui/PlateChip';
import { vehicleClassToPlateVariant } from '@/shared/lib/plate';
import { VIDEO_OVERLAY } from '@/shared/theme/tokens';
import { VehicleClass } from './VehicleClass';
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
  /** False while the feed is not playing yet (button disabled). Default true. */
  ready?: boolean;
  className?: string;
}

type Status = 'idle' | 'running' | 'done' | 'error';

export function LiveDetectPanel({ videoRef, cameraCode, ready = true, className = '' }: LiveDetectPanelProps) {
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
    <div className={`space-y-3 ${className}`}>
      <Button
        variant="primary"
        fullWidth
        onClick={run}
        loading={running}
        disabled={!ready}
        title={ready ? undefined : 'Waiting for the live feed'}
        icon={<ScanLineIcon size={14} strokeWidth={1.75} />}
      >
        {running ? 'Detecting…' : 'Run AI detection on this frame'}
      </Button>

      {status === 'error' && error && (
        <div role="alert" className="flex items-start gap-2 rounded-sm border border-danger/35 bg-danger/12 px-3 py-2 text-xs text-danger">
          <TriangleAlertIcon size={14} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {status === 'idle' && (
        <p className="text-xs text-fg-muted">
          Captures the current frame of camera <span className="font-mono">{cameraCode}</span> and runs plate detection + OCR on the GPU server.
        </p>
      )}

      {frame && result && (
        <>
          <div className="relative w-full overflow-hidden rounded-md border border-line" style={{ background: VIDEO_OVERLAY.frameBg }}>
            <img src={frame.dataUrl} alt={`Analysed frame from ${cameraCode}`} className="block h-auto w-full" />
            <canvas ref={overlayRef} data-testid="detect-overlay" className="pointer-events-none absolute inset-0 h-full w-full" />
          </div>

          <dl className="grid grid-cols-3 gap-2 text-xs">
            <div className="rounded-sm bg-surface-2 px-2 py-1.5">
              <dt className="text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">Latency</dt>
              <dd className="font-mono tabular-nums text-fg">{result.latency_ms} ms</dd>
            </div>
            <div className="rounded-sm bg-surface-2 px-2 py-1.5">
              <dt className="text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">Inference</dt>
              <dd className="font-mono tabular-nums text-fg">{result.inference_ms != null ? `${result.inference_ms} ms` : '—'}</dd>
            </div>
            <div className="rounded-sm bg-surface-2 px-2 py-1.5">
              <dt className="text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">Frame</dt>
              <dd className="font-mono tabular-nums text-fg">t={frame.timestampSec.toFixed(2)}s</dd>
            </div>
          </dl>
          <p className="text-2xs text-fg-subtle">
            Model <span className="font-mono">{result.engine} {result.model_version}</span>
          </p>

          {plates.length === 0 ? (
            <p className="text-xs text-fg-muted">No vehicles or plates detected in this frame.</p>
          ) : (
            <ul className="divide-y divide-line rounded-md border border-line">
              {plates.map((d, i) => (
                <li key={i} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                  {d.plate_text ? (
                    <PlateChip plate={d.plate_text} size="sm" variant={vehicleClassToPlateVariant(d.vehicle_type)} />
                  ) : (
                    <span className="text-fg-muted">Plate unreadable</span>
                  )}
                  <span className="flex items-center gap-3 text-fg-muted">
                    <VehicleClass type={d.vehicle_type} iconOnly />
                    <span className="font-mono tabular-nums">OCR {pct(d.plate_confidence)}</span>
                    <span className="font-mono tabular-nums">Det {pct(d.confidence)}</span>
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
