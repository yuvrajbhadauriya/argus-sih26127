// Right rail of the Cameras screen: AI engine status, the live plate reads of
// the selected camera (the real model reads on this clip, replayed on the
// camera's live clock — the same instants the video overlay shows them) and
// camera health.
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ListIcon, ScanLineIcon } from 'lucide-react';
import type { Camera } from '@/types/camera';
import type { Detection } from '@/types';
import { Panel } from '@/shared/ui/Card';
import { EmptyState } from '@/shared/ui/EmptyState';
import { PlateChip } from '@/shared/ui/PlateChip';
import { SeverityChip } from '@/shared/ui/SeverityChip';
import { StatusPill } from '@/shared/ui/StatusPill';
import { normalizePlate } from '@/shared/lib/plate';
import { AiEngineStatusPill } from '@/features/ai-engine/components/AiEngineStatus';
import { useLiveReads } from '@/features/detections/hooks/useLiveReads';
import { useLiveAnpr, type LiveAnprState } from '@/features/detections/hooks/useLiveAnpr';
import { useWatchlistIndex } from '@/features/detections/hooks/useWatchlistKeys';
import { DISPLAY_READ_MIN_CONFIDENCE } from '@/features/detections/api';
import { plateKey } from '@/features/detections/lib/log';
import { formatIstTime } from '@/features/live-map/lib/time';
import type { FeedStatus } from './CameraVideoPlayer';
import { LiveGpuReads } from './LiveGpuReads';

interface CameraAiPanelProps {
  camera: Camera;
  feedStatus: FeedStatus;
  detections: Detection[];
  resolution: string | null;
  lastFrameAt: number | null;
  /** The playing <video>; live GPU ANPR analyses its frames. */
  video?: HTMLVideoElement | null;
}

function HealthRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right text-xs text-fg">{children}</dd>
    </div>
  );
}

const MIN_PCT = Math.round(DISPLAY_READ_MIN_CONFIDENCE * 100);

/**
 * A line shown while the live GPU model is being reached. When it cannot be reached (the hosted site
 * is not on the model's LAN/VPN, by design) there is no notice: the panel's footer already says these
 * are the engine's real recorded reads, replayed on the camera's clock.
 */
function liveNotice(live: LiveAnprState): string | null {
  return live.status === 'connecting' ? 'Connecting to the live GPU model…' : null;
}

export function LivePlateReads({ camera, notice }: { camera: Camera; notice?: string | null }) {
  const navigate = useNavigate();
  const watch = useWatchlistIndex();
  const { reads, docs, loading, now } = useLiveReads(camera.code, { limit: 25 });
  const doc = docs[0];
  const vehicles = doc?.events.length ?? 0;

  return (
    <Panel
      flush
      title="Live plate reads"
      icon={<ScanLineIcon />}
      actions={
        doc ? (
          <span className="text-2xs tabular-nums text-fg-muted" title="Vehicles the AI engine tracked on this camera's clip">
            {vehicles} vehicles
          </span>
        ) : undefined
      }
    >
      {reads.length === 0 ? (
        <EmptyState
          compact
          icon={<ListIcon size={20} />}
          title={loading ? 'Loading reads…' : doc ? 'No readable plates on this camera' : 'No ANPR output for this clip'}
          description={
            loading
              ? undefined
              : doc
                ? `Vehicles are tracked on the video, but no plate was read at ≥ ${MIN_PCT} % with a valid format (angle, distance or lighting).`
                : 'The AI engine has not processed this camera’s clip yet.'
          }
        />
      ) : (
        <ol aria-label={`Plate reads at ${camera.name}, newest first`} className="max-h-[320px] overflow-y-auto" aria-live="polite">
          {reads.map((r) => {
            const plate = r.event.plate_text!;
            const hit = watch.get(plateKey(plate)) ?? null;
            const ago = Math.max(0, Math.round((now - r.at) / 1000));
            return (
              <li key={r.key}>
                <button
                  type="button"
                  onClick={() => navigate(`/vehicles?plate=${encodeURIComponent(normalizePlate(plate))}`)}
                  className="relative flex h-12 w-full items-center gap-3 border-b border-line px-3 text-left transition-colors hover:bg-surface-2 focus-visible:bg-surface-2"
                  aria-label={`Trace ${plate}`}
                >
                  {hit && <span className="absolute inset-y-0 left-0 w-0.5 bg-danger" aria-hidden="true" />}
                  <PlateChip plate={plate} size="sm" flag={hit ? 'watchlist' : null} />
                  {hit && <SeverityChip severity={hit} size="sm" />}
                  <span className="ml-auto flex shrink-0 flex-col items-end leading-tight">
                    <span className="font-mono text-2xs tabular-nums text-fg">{Math.round((r.event.plate_confidence ?? 0) * 100)}%</span>
                    <span className="font-mono text-2xs tabular-nums text-fg-subtle" title={`${ago}s ago`}>{formatIstTime(r.at)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {notice && <p className="border-t border-line px-3 py-2 text-2xs text-warning">{notice}</p>}
      <p className="border-t border-line px-3 py-2 text-2xs text-fg-subtle">
        Real reads by the AI ANPR engine on this clip (OCR ≥ {MIN_PCT} %, valid Indian plate format), replayed on the camera&apos;s live clock.
      </p>
    </Panel>
  );
}

export function CameraAiPanel({ camera, feedStatus, detections, resolution, lastFrameAt, video = null }: CameraAiPanelProps) {
  const vehicles = useMemo(() => new Set(detections.map((d) => d.tracked_vehicle_id ?? d.event_id)).size, [detections]);
  const status = feedStatus === 'offline' ? 'offline' : feedStatus === 'playing' ? 'live' : 'connecting';
  // Real-time ANPR on the playing feed; falls back to the recorded reads when the GPU model cannot be reached.
  const live = useLiveAnpr(feedStatus === 'playing' ? video : null, camera.code);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <AiEngineStatusPill variant="panel" />

      {live.status === 'live' ? <LiveGpuReads camera={camera} live={live} /> : <LivePlateReads camera={camera} notice={liveNotice(live)} />}

      <Panel title="Camera health">
        <dl className="divide-y divide-line">
          <HealthRow label="Status"><StatusPill status={status} size="sm" /></HealthRow>
          <HealthRow label="Stream resolution"><span className="font-mono tabular-nums">{resolution ?? '—'}</span></HealthRow>
          <HealthRow label="Last frame">
            <span className="font-mono tabular-nums">{lastFrameAt ? `${formatIstTime(lastFrameAt)} IST` : '—'}</span>
          </HealthRow>
          <HealthRow label="Tracked in clip">
            <span className="tabular-nums">
              {vehicles.toLocaleString('en-IN')} vehicles <span className="text-fg-muted">· {detections.length.toLocaleString('en-IN')} boxes</span>
            </span>
          </HealthRow>
          <HealthRow label="Road">{camera.road ?? '—'}</HealthRow>
        </dl>
      </Panel>
    </div>
  );
}
