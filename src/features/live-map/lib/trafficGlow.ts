// Glow icon + accessible description for the Traffic layer.
import L from 'leaflet';
import type { Camera } from '@/types/camera';
import { heatColors, type TrafficReading } from './trafficDensity';

const SIZE = 92;
const iconCache = new Map<string, L.DivIcon>();

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function trafficDescription(camera: Pick<Camera, 'code' | 'name'>, r: TrafficReading): string {
  return `${camera.code} ${camera.name}: ${r.count} vehicle${r.count === 1 ? '' : 's'} in view (last ${r.windowSec} s) · ${r.level} traffic`;
}

export function glowIcon(label: string, intensity: number): L.DivIcon {
  // quantised, so the icon only changes when the glow visibly does
  const step = Math.round(Math.max(0, Math.min(1, intensity)) * 20) / 20;
  const key = `${step}|${label}`;
  let icon = iconCache.get(key);
  if (!icon) {
    const { core, mid } = heatColors(step);
    icon = L.divIcon({
      className: 'nero-heat-icon',
      html: `<div class="nero-heat" role="img" aria-label="${esc(label)}" style="--heat-core:${core};--heat-mid:${mid}"></div>`,
      iconSize: [SIZE, SIZE],
      iconAnchor: [SIZE / 2, SIZE / 2],
    });
    if (iconCache.size > 400) iconCache.clear();
    iconCache.set(key, icon);
  }
  return icon;
}

