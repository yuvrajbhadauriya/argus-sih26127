// Small static-ish Leaflet map for the alert detail panel.

import { useEffect } from 'react';
import { MapContainer, CircleMarker, Polyline, Tooltip, useMap } from 'react-leaflet';
import { BaseTileLayer } from '@/shared/map/BaseTileLayer';
import { useThemeTokens } from '@/shared/theme/tokens';

export interface MiniMapPoint {
  lat: number;
  lng: number;
  label: string;
  /** The camera that raised the alert. */
  primary?: boolean;
}

function Fit({ points }: { points: MiniMapPoint[] }) {
  const map = useMap();
  const key = points.map((p) => `${p.lat},${p.lng}`).join('|');
  useEffect(() => {
    if (!map?.fitBounds || points.length === 0) return;
    if (points.length === 1) map.setView([points[0].lat, points[0].lng], 14, { animate: false });
    else map.fitBounds(points.map((p) => [p.lat, p.lng] as [number, number]), { padding: [24, 24], maxZoom: 14, animate: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, map]);
  return null;
}

export function AlertMiniMap({ points, link = false }: { points: MiniMapPoint[]; link?: boolean }) {
  const t = useThemeTokens();
  if (points.length === 0) return null;
  const unique = points.filter((p, i) => points.findIndex((o) => o.lat === p.lat && o.lng === p.lng) === i);
  return (
    <MapContainer
      center={[points[0].lat, points[0].lng]}
      zoom={14}
      zoomControl={false}
      scrollWheelZoom={false}
      className="h-full w-full"
      style={{ background: 'var(--map-bg)' }}
    >
      <BaseTileLayer />
      <Fit points={unique} />
      {link && unique.length > 1 && (
        <Polyline positions={points.map((p) => [p.lat, p.lng] as [number, number])} pathOptions={{ color: t.danger, weight: 2, dashArray: '6 6', opacity: 0.9 }} />
      )}
      {unique.map((p) => (
        <CircleMarker
          key={`${p.lat},${p.lng}`}
          center={[p.lat, p.lng]}
          radius={p.primary ? 8 : 6}
          pathOptions={{ color: t.map.markerHalo, weight: 2, fillColor: p.primary ? t.danger : t.sev.high, fillOpacity: 1 }}
        >
          <Tooltip direction="top" offset={[0, -6]} permanent={p.primary}>
            <span className="text-xs font-semibold">{p.label}</span>
          </Tooltip>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}
