// ═══════════════════════════════════════════════════
// MapView — Leaflet map of the camera network (Live Map).
// Theme-aware base map, camera markers, optional alert hotspot layer, and a
// controller that flies to the selected camera / recentres on request.
// ═══════════════════════════════════════════════════

import { useEffect, useRef, type ReactNode } from 'react';
import { CircleMarker, MapContainer, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import { BaseTileLayer } from '@/shared/map/BaseTileLayer';
import { useThemeTokens } from '@/shared/theme/tokens';
import { DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM } from '@/config/constants';
import type { Camera } from '@/types/camera';
import type { AlertHotspot } from '../lib/alerts';
import type { TrafficReading } from '../lib/trafficDensity';
import { CameraMarker } from './CameraMarker';
import { TrafficLayer } from './TrafficLayer';

/** Zoom from which camera code labels are shown. */
export const LABEL_ZOOM = 13;

interface MapViewProps {
  cameras: Camera[];
  selectedCode?: string | null;
  onSelect?: (camera: Camera) => void;
  lastPlateByCamera?: Record<string, string | undefined>;
  showCameras?: boolean;
  showLabels?: boolean;
  hotspots?: AlertHotspot[];
  /** Traffic heat glow per camera code; omitted / empty = layer off. */
  traffic?: ReadonlyMap<string, TrafficReading> | null;
  /** Increment to fit the map to all cameras again. */
  recenterNonce?: number;
  /** Increment to fly to the selected camera (e.g. picked from a list). */
  focusNonce?: number;
  className?: string;
  children?: ReactNode;
}

type MaybeMap = Partial<L.Map>;

function fitAll(map: MaybeMap, cameras: Camera[]) {
  if (cameras.length === 0) {
    map.setView?.(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);
    return;
  }
  const bounds = L.latLngBounds(cameras.map((c) => [c.latitude, c.longitude] as [number, number]));
  map.fitBounds?.(bounds, { padding: [48, 48], maxZoom: 14 });
}

function MapController({
  cameras, selected, recenterNonce, focusNonce,
}: { cameras: Camera[]; selected: Camera | null; recenterNonce: number; focusNonce: number }) {
  const map = useMap() as MaybeMap;
  const camsRef = useRef(cameras);
  useEffect(() => {
    camsRef.current = cameras;
  }, [cameras]);

  // Zoom buttons bottom-right: the top corners hold the sector card and layer toggles.
  useEffect(() => {
    map.zoomControl?.setPosition?.('bottomright');
  }, [map]);

  // Code labels from LABEL_ZOOM up: toggle a class on the container instead of rebuilding icons.
  useEffect(() => {
    if (typeof map.on !== 'function' || typeof map.getContainer !== 'function') return;
    const apply = () => map.getContainer!().classList.toggle('nero-cam-labels', (map.getZoom?.() ?? 0) >= LABEL_ZOOM);
    apply();
    map.on('zoomend', apply);
    return () => {
      map.off?.('zoomend', apply);
    };
  }, [map]);

  // Recentre (also the initial framing once cameras arrive).
  const hasCams = cameras.length > 0;
  useEffect(() => {
    if (hasCams || recenterNonce > 0) fitAll(map, camsRef.current);
  }, [map, recenterNonce, hasCams]);

  // Fly to the selection when asked (list click, ?cam= deep link).
  const target = selected ? ([selected.latitude, selected.longitude] as [number, number]) : null;
  const targetKey = target ? target.join(',') : '';
  useEffect(() => {
    if (!target || focusNonce === 0) return;
    const z = Math.max(map.getZoom?.() ?? 0, 15);
    map.flyTo?.(target, z, { duration: 0.6 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, focusNonce, targetKey]);

  return null;
}

export function MapView({
  cameras,
  selectedCode = null,
  onSelect,
  lastPlateByCamera = {},
  showCameras = true,
  showLabels = true,
  hotspots = [],
  traffic = null,
  recenterNonce = 0,
  focusNonce = 0,
  className = '',
  children,
}: MapViewProps) {
  const tokens = useThemeTokens();
  const selected = cameras.find((c) => c.code === selectedCode) ?? null;

  return (
    <MapContainer
      center={DEFAULT_MAP_CENTER}
      zoom={DEFAULT_MAP_ZOOM}
      className={`h-full w-full ${className}`}
      zoomControl
      attributionControl
    >
      <BaseTileLayer labels={showLabels} />
      <MapController cameras={cameras} selected={selected} recenterNonce={recenterNonce} focusNonce={focusNonce} />

      {hotspots.map((h) => (
        <CircleMarker
          key={h.key}
          center={[h.lat, h.lng]}
          radius={14 + Math.min(h.count, 6) * 3}
          pathOptions={{ color: tokens.sev.critical, weight: 2, fillColor: tokens.sev.critical, fillOpacity: 0.12 }}
          interactive
        >
          <Tooltip direction="top" offset={[0, -8]}>
            {h.count} open alert{h.count === 1 ? '' : 's'} · {h.cameraName}
          </Tooltip>
        </CircleMarker>
      ))}

      {traffic && <TrafficLayer cameras={cameras} readings={traffic} />}

      {showCameras &&
        cameras.map((camera) => (
          <CameraMarker
            key={camera.id}
            camera={camera}
            selected={camera.code === selectedCode}
            lastPlate={lastPlateByCamera[camera.id]}
            onSelect={onSelect}
          />
        ))}
      {children}
    </MapContainer>
  );
}
