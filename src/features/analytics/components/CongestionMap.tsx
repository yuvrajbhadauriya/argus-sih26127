// ═══════════════════════════════════════════════════
// CongestionMap — spatial density layer for the Analytics page
//  • camera load: heat circles sized by sightings, coloured by bottleneck score
//  • route density: road-snapped corridors weighted by trips in the window
// ═══════════════════════════════════════════════════

import { useEffect, useMemo, useState } from 'react';
import { MapContainer, CircleMarker, Circle, Polyline, Tooltip, useMap } from 'react-leaflet';
import { BaseTileLayer } from '@/shared/map/BaseTileLayer';
import { MapLegend, MapPanel } from '@/shared/ui/MapLegend';
import { useThemeTokens } from '@/shared/theme/tokens';
import { DEFAULT_MAP_CENTER } from '@/config/constants';
import type { RoadRoutesDoc } from '@/features/vehicles/lib/trajectory';
import { routeKey } from '@/features/vehicles/lib/trajectory';
import type { CameraLoad, Corridor } from '../lib/aggregate';
import { fmtInt } from './charts/chartUtils';

interface CongestionMapProps {
  cameras: CameraLoad[];
  corridors: Corridor[];
  routes: RoadRoutesDoc | null;
  className?: string;
}

/** Frame all cameras once the map has a size. */
function FitCameras({ cameras }: { cameras: CameraLoad[] }) {
  const map = useMap();
  const key = cameras.map((c) => c.code).join('|');
  useEffect(() => {
    if (!map?.fitBounds || cameras.length === 0) return;
    map.fitBounds(cameras.map((c) => [c.lat, c.lng] as [number, number]), { paddingTopLeft: [40, 40], paddingBottomRight: [40, 40], animate: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, map]);
  return null;
}

/** 0..1 → index into a 5-step ramp. */
const step5 = (t: number) => Math.max(0, Math.min(4, Math.floor(t * 5)));

export function CongestionMap({ cameras, corridors, routes, className }: CongestionMapProps) {
  const tokens = useThemeTokens();
  const [showLoad, setShowLoad] = useState(true);
  const [showRoutes, setShowRoutes] = useState(true);

  const maxSightings = Math.max(1, ...cameras.map((c) => c.sightings));
  const maxScore = Math.max(1, ...cameras.map((c) => c.bottleneckScore));
  const maxTrips = Math.max(1, ...corridors.map((c) => c.trips));

  const lines = useMemo(() => {
    if (!routes) return [];
    return corridors
      .map((c) => {
        const r = routes.routes[routeKey(c.from.code, c.to.code)] ?? routes.routes[routeKey(c.to.code, c.from.code)];
        return r ? { c, coords: r.coordinates } : null;
      })
      .filter((x): x is { c: Corridor; coords: [number, number][] } => x != null)
      .sort((a, b) => a.c.trips - b.c.trips); // busiest drawn last (on top)
  }, [corridors, routes]);

  return (
    <div className={`relative h-full w-full ${className ?? ''}`}>
      <MapContainer
        center={DEFAULT_MAP_CENTER}
        zoom={11}
        minZoom={10}
        scrollWheelZoom={false}
        className="h-full w-full"
        style={{ background: 'var(--map-bg)' }}
        aria-label="Congestion and route density map"
      >
        <BaseTileLayer />
        <FitCameras cameras={cameras} />
        {showRoutes &&
          lines.map(({ c, coords }) => {
            const t = c.trips / maxTrips;
            return (
              <Polyline
                key={c.id}
                positions={coords}
                pathOptions={{ color: tokens.heat[step5(t)], weight: 2 + t * 8, opacity: 0.85, lineCap: 'round', lineJoin: 'round' }}
              >
                <Tooltip sticky>
                  <span className="text-xs font-semibold">{c.from.name} – {c.to.name}</span>
                  <span className="block text-2xs tabular-nums">
                    {fmtInt(c.trips)} trips · avg {Math.round(c.avgTimeS / 60)} min · {c.avgSpeed} km/h
                  </span>
                </Tooltip>
              </Polyline>
            );
          })}
        {showLoad &&
          cameras.map((c) => {
            const color = tokens.heat[step5(c.bottleneckScore / maxScore)];
            const radiusM = 350 + 1300 * Math.sqrt(c.sightings / maxSightings);
            return (
              <Circle
                key={`halo-${c.code}`}
                center={[c.lat, c.lng]}
                radius={radiusM}
                pathOptions={{ stroke: false, fillColor: color, fillOpacity: 0.35 }}
                interactive={false}
              />
            );
          })}
        {cameras.map((c) => {
          const color = tokens.heat[step5(c.bottleneckScore / maxScore)];
          return (
            <CircleMarker
              key={c.code}
              center={[c.lat, c.lng]}
              radius={6}
              pathOptions={{ color: tokens.map.markerHalo, weight: 2, fillColor: showLoad ? color : tokens.map.camIdle, fillOpacity: 1 }}
            >
              <Tooltip direction="top" offset={[0, -6]}>
                <span className="text-xs font-semibold">{c.name}</span>
                <span className="block font-mono text-2xs">{c.code} · {c.zone}</span>
                <span className="block text-2xs tabular-nums">
                  {fmtInt(c.sightings)} sightings · {c.avgSpeed ?? '—'} km/h avg approach
                </span>
              </Tooltip>
            </CircleMarker>
          );
        })}
      </MapContainer>

      <MapPanel position="top-right" className="px-2.5 py-2">
        <fieldset className="space-y-1">
          <legend className="sr-only">Map layers</legend>
          <label className="flex cursor-pointer items-center gap-2 text-fg">
            <input type="checkbox" checked={showLoad} onChange={(e) => setShowLoad(e.target.checked)} className="accent-[var(--primary)]" />
            Camera load
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-fg">
            <input type="checkbox" checked={showRoutes} onChange={(e) => setShowRoutes(e.target.checked)} className="accent-[var(--primary)]" />
            Route density
          </label>
        </fieldset>
      </MapPanel>

      <MapLegend
        title="Density"
        position="bottom-left"
        items={[
          { label: 'Circle size = sightings', color: tokens.fgSubtle, shape: 'ring' },
          { label: 'Line width = corridor trips', color: tokens.fgSubtle, shape: 'line' },
        ]}
        ramp={{ label: 'Bottleneck / trip intensity', stops: [...tokens.heat], min: 'Low', max: 'High' }}
      />
    </div>
  );
}
