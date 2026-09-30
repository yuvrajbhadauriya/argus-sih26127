// ═══════════════════════════════════════════════════
// CameraMarker — one camera on the Live Map.
// 12px status dot with a halo; selected = ring in --map-selected; code label
// chip from zoom 13 (see camera-marker.css). Popup has the camera details
// and deep links to the feed and the detections log.
// ═══════════════════════════════════════════════════

import { useMemo } from 'react';
import { Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import { useNavigate } from 'react-router-dom';
import { ListIcon, VideoIcon } from 'lucide-react';
import type { Camera } from '@/types/camera';
import { Button } from '@/shared/ui/Button';
import { StatusPill } from '@/shared/ui/StatusPill';
import { PlateChip } from '@/shared/ui/PlateChip';
import './camera-marker.css';

interface CameraMarkerProps {
  camera: Camera;
  selected?: boolean;
  /** Last plate read at this camera, if known */
  lastPlate?: string | null;
  onSelect?: (camera: Camera) => void;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function buildCameraIcon(status: Camera['status'], selected: boolean, code: string): L.DivIcon {
  return L.divIcon({
    className: 'nero-cam-icon',
    html: `<div class="nero-cam" data-status="${status}" data-selected="${selected}"><span class="nero-cam__dot"></span><span class="nero-cam__label">${escapeHtml(code)}</span></div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
    popupAnchor: [0, -10],
  });
}

// Shared DivIcons: a new icon object each render makes react-leaflet call
// setIcon() and rebuild the marker DOM. Colours are CSS variables, so the
// cache needs no theme key.
const iconCache = new Map<string, L.DivIcon>();
function getCameraIcon(status: Camera['status'], selected: boolean, code: string): L.DivIcon {
  const key = `${status}|${selected}|${code}`;
  let icon = iconCache.get(key);
  if (!icon) {
    icon = buildCameraIcon(status, selected, code);
    iconCache.set(key, icon);
  }
  return icon;
}

export function CameraMarker({ camera, selected = false, lastPlate, onSelect }: CameraMarkerProps) {
  const navigate = useNavigate();
  const icon = getCameraIcon(camera.status, selected, camera.code);
  const position = useMemo<[number, number]>(() => [camera.latitude, camera.longitude], [camera.latitude, camera.longitude]);
  const eventHandlers = useMemo(() => ({ click: () => onSelect?.(camera) }), [onSelect, camera]);

  return (
    <Marker
      position={position}
      icon={icon}
      eventHandlers={eventHandlers}
      title={`${camera.code} ${camera.name}`}
      alt={`Camera ${camera.code}`}
      zIndexOffset={selected ? 1000 : 0}
    >
      <Popup minWidth={240} maxWidth={300}>
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h4 className="truncate text-[13px] font-semibold text-fg">{camera.name}</h4>
              <div className="font-mono text-xs font-medium text-fg-muted">{camera.code}</div>
            </div>
            <StatusPill status={camera.status} size="sm" />
          </div>
          <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
            <dt className="text-fg-muted">Zone</dt>
            <dd className="truncate text-fg">{camera.zone}</dd>
            <dt className="text-fg-muted">Direction</dt>
            <dd className="truncate text-fg">{camera.direction}</dd>
            {camera.road && (
              <>
                <dt className="text-fg-muted">Road</dt>
                <dd className="truncate text-fg">{camera.road}</dd>
              </>
            )}
            {lastPlate && (
              <>
                <dt className="self-center text-fg-muted">Last read</dt>
                <dd><PlateChip plate={lastPlate} size="xs" /></dd>
              </>
            )}
          </dl>
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              icon={<VideoIcon size={14} strokeWidth={1.75} />}
              onClick={() => navigate(`/cameras?cam=${encodeURIComponent(camera.code)}`)}
            >
              Open feed
            </Button>
            <Button
              size="sm"
              icon={<ListIcon size={14} strokeWidth={1.75} />}
              onClick={() => navigate(`/detections?camera=${encodeURIComponent(camera.id)}`)}
            >
              Detections
            </Button>
          </div>
        </div>
      </Popup>
    </Marker>
  );
}
