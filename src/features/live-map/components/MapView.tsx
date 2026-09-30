// ═══════════════════════════════════════════════════
// MapView — Leaflet map wrapper component
// Dark-themed map with camera markers
// ═══════════════════════════════════════════════════

import { MapContainer } from 'react-leaflet';
import { BaseTileLayer } from '@/shared/map/BaseTileLayer';
import { DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM } from '@/config/constants';
import type { Camera } from '@/types/camera';
import { CameraMarker } from './CameraMarker';

interface MapViewProps {
  cameras: Camera[];
  onCameraClick?: (camera: Camera) => void;
  center?: [number, number];
  zoom?: number;
  className?: string;
}

export function MapView({
  cameras,
  onCameraClick,
  center = DEFAULT_MAP_CENTER,
  zoom = DEFAULT_MAP_ZOOM,
  className = '',
}: MapViewProps) {
  return (
    <MapContainer
      center={center}
      zoom={zoom}
      className={`h-full w-full rounded-xl ${className}`}
      zoomControl={true}
      attributionControl={true}
    >
      <BaseTileLayer />

      {/* Camera markers */}
      {cameras.map((camera) => (
        <CameraMarker
          key={camera.id}
          camera={camera}
          onClick={onCameraClick}
        />
      ))}
    </MapContainer>
  );
}
