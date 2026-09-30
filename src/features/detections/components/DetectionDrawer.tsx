// Detail drawer for one ANPR detection (Detections log row click).
import { useNavigate } from 'react-router-dom';
import { CctvIcon, RouteIcon } from 'lucide-react';
import type { Camera } from '@/types/camera';
import type { Detection } from '@/types';
import { Drawer } from '@/shared/ui/Modal';
import { Button } from '@/shared/ui/Button';
import { Badge } from '@/shared/ui/Badge';
import { PlateChip } from '@/shared/ui/PlateChip';
import { vehicleClassToPlateVariant } from '@/shared/lib/plate';
import { formatFrameTime, plateKey } from '../lib/log';
import { ConfidenceBar } from './ConfidenceBar';
import { VehicleClass } from './VehicleClass';

interface DetectionDrawerProps {
  detection: Detection | null;
  camera: Camera | null;
  onWatchlist: boolean;
  onClose: () => void;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-3 py-2">
      <dt className="text-xs font-medium text-fg-muted">{label}</dt>
      <dd className="min-w-0 text-[13px] text-fg">{children}</dd>
    </div>
  );
}

export function DetectionDrawer({ detection: d, camera, onWatchlist, onClose }: DetectionDrawerProps) {
  const navigate = useNavigate();
  if (!d) return null;
  const normalized = d.plate_text_normalized || plateKey(d.plate_text_raw);

  return (
    <Drawer
      open
      onClose={onClose}
      title="Detection"
      subtitle={<span className="font-mono">{d.event_id}</span>}
      footer={
        <div className="flex justify-end gap-2">
          <Button
            icon={<CctvIcon size={14} strokeWidth={1.75} />}
            disabled={!camera}
            onClick={() => camera && navigate(`/cameras?cam=${encodeURIComponent(camera.code)}`)}
          >
            Open camera
          </Button>
          <Button
            variant="primary"
            icon={<RouteIcon size={14} strokeWidth={1.75} />}
            onClick={() => navigate(`/vehicles?plate=${encodeURIComponent(plateKey(d.plate_text_raw))}`)}
          >
            Trace route
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <PlateChip plate={d.plate_text_raw} size="lg" variant={vehicleClassToPlateVariant(d.vehicle_type)} flag={onWatchlist ? 'watchlist' : null} />
          {onWatchlist && <Badge tone="danger" size="sm">Watchlist</Badge>}
        </div>

        {d.image_ref && (
          <figure className="overflow-hidden rounded-md border border-line bg-surface-2">
            <img src={d.image_ref} alt={`Plate crop for ${d.plate_text_raw}`} className="block max-h-48 w-full object-contain" />
          </figure>
        )}

        <dl className="divide-y divide-line">
          <Row label="Raw OCR text"><span className="font-mono">{d.plate_text_raw}</span></Row>
          <Row label="Normalised"><span className="font-mono">{normalized}</span></Row>
          <Row label="Confidence"><ConfidenceBar value={d.confidence_score} /></Row>
          <Row label="Class"><VehicleClass type={d.vehicle_type} /></Row>
          <Row label="Camera">
            {camera ? (
              <span className="flex min-w-0 items-center gap-2">
                <span className="font-mono text-xs font-medium text-fg-muted">{camera.code}</span>
                <span className="truncate">{camera.name}</span>
              </span>
            ) : (
              <span className="font-mono">{d.camera_id}</span>
            )}
          </Row>
          <Row label="Frame time"><span className="font-mono tabular-nums">{formatFrameTime(d.frame_timestamp_sec ?? d.timestamp)}</span></Row>
          {d.tracked_vehicle_id != null && <Row label="Track ID"><span className="font-mono tabular-nums">#{d.tracked_vehicle_id}</span></Row>}
          <Row label="Bounding box">
            <span className="font-mono text-xs tabular-nums text-fg-muted">
              x {d.bbox.x} · y {d.bbox.y} · w {d.bbox.width} · h {d.bbox.height}
            </span>
          </Row>
        </dl>
      </div>
    </Drawer>
  );
}
