// Soft radial heat glow under each camera marker: colour and strength follow the traffic seen by the camera
// (lib/trafficDensity.ts). A filled gradient, unlike the alert hotspots' outlined rings.
import { Marker, Tooltip } from 'react-leaflet';
import type { Camera } from '@/types/camera';
import { TRAFFIC_LABEL, type TrafficReading } from '../lib/trafficDensity';
import { glowIcon, trafficDescription } from '../lib/trafficGlow';
import './camera-marker.css';

export function TrafficLayer({ cameras, readings }: { cameras: Camera[]; readings: ReadonlyMap<string, TrafficReading> }) {
  return (
    <>
      {cameras.map((camera) => {
        const r = readings.get(camera.code);
        if (!r) return null;
        const label = trafficDescription(camera, r);
        return (
          <Marker
            key={`traffic-${camera.id}`}
            position={[camera.latitude, camera.longitude]}
            icon={glowIcon(label, r.intensity)}
            zIndexOffset={-10000}
            keyboard={false}
          >
            <Tooltip direction="top" offset={[0, -10]}>
              <strong>{label}</strong>
              <br />
              <span>{TRAFFIC_LABEL}</span>
            </Tooltip>
          </Marker>
        );
      })}
    </>
  );
}
