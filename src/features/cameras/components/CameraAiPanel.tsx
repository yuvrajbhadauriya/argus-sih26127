// Right rail of the Cameras screen: on-demand AI detection for the current
// frame, the pipeline detections recorded for this clip, and camera health.
import { useMemo, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { BrainCircuitIcon, ListIcon } from 'lucide-react';
import type { Camera } from '@/types/camera';
import type { Detection } from '@/types';
import { Panel } from '@/shared/ui/Card';
import { DataTable, type Column } from '@/shared/ui/DataTable';
import { EmptyState } from '@/shared/ui/EmptyState';
import { PlateChip } from '@/shared/ui/PlateChip';
import { StatusPill } from '@/shared/ui/StatusPill';
import { vehicleClassToPlateVariant } from '@/shared/lib/plate';
import { LiveDetectPanel } from '@/features/detections/components/LiveDetectPanel';
import { VehicleClass } from '@/features/detections/components/VehicleClass';
import { formatFrameTime, plateKey, recentPlateReads } from '@/features/detections/lib/log';
import { formatIstTime } from '@/features/live-map/lib/time';
import type { FeedStatus } from './CameraVideoPlayer';

interface CameraAiPanelProps {
  camera: Camera;
  videoRef: RefObject<HTMLVideoElement | null>;
  feedStatus: FeedStatus;
  detections: Detection[];
  resolution: string | null;
  lastFrameAt: number | null;
}

function HealthRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right text-xs text-fg">{children}</dd>
    </div>
  );
}

export function CameraAiPanel({ camera, videoRef, feedStatus, detections, resolution, lastFrameAt }: CameraAiPanelProps) {
  const navigate = useNavigate();
  const reads = useMemo(() => recentPlateReads(detections), [detections]);
  const vehicles = useMemo(() => new Set(detections.map((d) => d.tracked_vehicle_id ?? d.event_id)).size, [detections]);

  const columns: Column<Detection>[] = [
    { key: 't', header: 'Frame', width: '80px', mono: true, cell: (d) => formatFrameTime(d.frame_timestamp_sec ?? d.timestamp) },
    { key: 'plate', header: 'Plate', cell: (d) => <PlateChip plate={d.plate_text_raw} size="xs" variant={vehicleClassToPlateVariant(d.vehicle_type)} /> },
    { key: 'class', header: 'Class', width: '44px', align: 'center', cell: (d) => <VehicleClass type={d.vehicle_type} iconOnly /> },
    { key: 'conf', header: 'Conf', width: '52px', align: 'right', mono: true, cell: (d) => `${Math.round(d.confidence_score * 100)}%` },
  ];

  const status = feedStatus === 'offline' ? 'offline' : feedStatus === 'playing' ? 'live' : 'connecting';

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Panel title="AI Detection" subtitle="YOLOv7-tiny ANPR" icon={<BrainCircuitIcon />}>
        <LiveDetectPanel videoRef={videoRef} cameraCode={camera.code} ready={feedStatus === 'playing'} />
      </Panel>

      <Panel
        flush
        title={`Recent detections at ${camera.code}`}
        icon={<ListIcon />}
        actions={<span className="text-xs tabular-nums text-fg-muted">{reads.length}</span>}
      >
        <DataTable
          caption={`Plate reads at ${camera.name}`}
          columns={columns}
          rows={reads}
          rowKey={(d) => d.event_id}
          maxHeight="280px"
          onRowClick={(d) => navigate(`/vehicles?plate=${encodeURIComponent(plateKey(d.plate_text_raw))}`)}
          empty={
            <EmptyState
              compact
              icon={<ListIcon size={20} />}
              title={feedStatus === 'playing' ? 'No detections yet — run the AI pipeline' : 'Waiting for the feed'}
              description={
                feedStatus === 'playing'
                  ? 'No recorded plate reads for this clip. Run the ANPR pipeline on it, or detect the current frame above.'
                  : 'Pipeline detections load once the feed is on screen.'
              }
            />
          }
        />
      </Panel>

      <Panel title="Camera health">
        <dl className="divide-y divide-line">
          <HealthRow label="Status"><StatusPill status={status} size="sm" /></HealthRow>
          <HealthRow label="Stream resolution"><span className="font-mono tabular-nums">{resolution ?? '—'}</span></HealthRow>
          <HealthRow label="Last frame">
            <span className="font-mono tabular-nums">{lastFrameAt ? `${formatIstTime(lastFrameAt)} IST` : '—'}</span>
          </HealthRow>
          <HealthRow label="Detections in clip">
            <span className="tabular-nums">
              {detections.length.toLocaleString('en-IN')} <span className="text-fg-muted">· {vehicles} vehicles</span>
            </span>
          </HealthRow>
          <HealthRow label="Road">{camera.road ?? '—'}</HealthRow>
        </dl>
      </Panel>
    </div>
  );
}
