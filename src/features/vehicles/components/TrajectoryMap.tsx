// ═══════════════════════════════════════════════════
// TrajectoryMap Component
// Road-snapped journey path, numbered stops in time order, direction arrows,
// per-hop time/speed/distance labels and an animated replay.
// Overlays follow the UI theme: divIcons use var(--map-…), Leaflet paths use
// useThemeTokens().
// ═══════════════════════════════════════════════════

import { MapContainer, Polyline, Marker, Popup, Tooltip, CircleMarker, ZoomControl, useMap } from 'react-leaflet';
import L from 'leaflet';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PauseIcon, PlayIcon, RotateCcwIcon, SkipBackIcon, SkipForwardIcon } from 'lucide-react';
import type { Trajectory, TrajectoryWaypoint } from '@/types';
import { BaseTileLayer } from '@/shared/map/BaseTileLayer';
import { IconButton } from '@/shared/ui/Button';
import { MapLegend, MapPanel, type LegendItem } from '@/shared/ui/MapLegend';
import { useThemeTokens } from '@/shared/theme/tokens';
import { mockCameras } from '@/mocks/fixtures/mockCameras';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';
import { cumulativeM, formatDistance, formatIstHm, formatIstTime, formatSpeed, pointAlong, type LatLngTuple } from '../lib/geo';
import { buildReplayModel, positionsAt, realTimeAt, replayMsAt, stopIndexAt, type ReplayModel } from '../lib/replay';
import { textOn, tripColors } from '../lib/colors';
import { SimulationBadge } from './SimulationBadge';

interface TrajectoryMapProps {
  trajectory: Trajectory;
  /** Highlighted stop (index into waypoints) */
  activeIndex?: number | null;
  /** Called when the replay reaches a stop or a stop marker is clicked */
  onActiveIndexChange?: (index: number) => void;
  /** Bump `nonce` to pan the map to `index` (e.g. after a timeline click) */
  focusRequest?: { index: number; nonce: number } | null;
  className?: string;
}

const REPLAY_SPEEDS = [0.5, 1, 2, 4] as const;

// ── Icon factories (cached; Leaflet icons are immutable) ──

const iconCache = new Map<string, L.DivIcon>();
function cachedIcon(key: string, make: () => L.DivIcon): L.DivIcon {
  let icon = iconCache.get(key);
  if (!icon) {
    icon = make();
    iconCache.set(key, icon);
  }
  return icon;
}

function stopIcon(label: string, color: string, active: boolean): L.DivIcon {
  return cachedIcon(`stop|${label}|${color}|${active}`, () => {
    const size = active ? 30 : 26;
    const wide = label.length > 2;
    return L.divIcon({
      className: 'trajectory-stop-icon',
      html: `<div style="min-width:${size}px;height:${size}px;padding:0 ${wide ? 8 : 0}px;background:${color};color:${textOn(color)};
        border:2px solid var(--map-marker-halo);border-radius:9999px;display:flex;align-items:center;justify-content:center;
        font:700 ${active ? 13 : 12}px/1 Inter,system-ui,sans-serif;font-variant-numeric:tabular-nums;
        box-shadow:${active ? '0 0 0 3px var(--map-selected),' : ''}0 1px 3px rgba(0,0,0,.35);
        transform:translate(-50%,-50%);position:absolute;left:0;top:0;white-space:nowrap">${label}</div>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
      popupAnchor: [0, -18],
    });
  });
}

function arrowIcon(bearing: number, color: string): L.DivIcon {
  const deg = Math.round(bearing / 5) * 5;
  return cachedIcon(`arrow|${deg}|${color}`, () =>
    L.divIcon({
      className: 'trajectory-arrow-icon',
      html: `<div style="width:14px;height:14px;transform:translate(-50%,-50%) rotate(${deg}deg);position:absolute;left:0;top:0">
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 3 L20 20 L12 15 L4 20 Z" fill="${color}" stroke="var(--map-marker-halo)" stroke-width="2" stroke-linejoin="round"/></svg></div>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    }),
  );
}

function hopLabelIcon(text: string, sub: string, color: string): L.DivIcon {
  return cachedIcon(`hop|${text}|${sub}|${color}`, () =>
    L.divIcon({
      className: 'trajectory-hop-label',
      html: `<div style="transform:translate(-50%,-135%);position:absolute;left:0;top:0;white-space:nowrap;pointer-events:none;
        background:var(--map-label-bg);border:1px solid var(--map-label-border);border-left:3px solid ${color};border-radius:4px;
        padding:2px 6px;color:var(--map-label-fg);font:600 11px/1.35 Inter,system-ui,sans-serif;font-variant-numeric:tabular-nums;
        box-shadow:var(--shadow-pop)">
        <div>${text}</div><div style="color:var(--fg-muted);font-weight:500">${sub}</div></div>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    }),
  );
}

function vehicleIcon(color: string): L.DivIcon {
  return cachedIcon(`veh|${color}`, () =>
    L.divIcon({
      className: 'trajectory-vehicle-icon',
      html: `<div style="position:absolute;left:0;top:0;transform:translate(-50%,-50%);width:18px;height:18px;border-radius:9999px;
        background:${color};border:3px solid var(--map-marker-halo);box-shadow:0 0 0 5px ${color}40,0 1px 4px rgba(0,0,0,.4)"></div>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    }),
  );
}

// ── Derived geometry ──

interface StopGroup {
  key: string;
  at: LatLngTuple;
  indices: number[];
  name: string;
  code?: string;
  trip: number;
}

function groupStops(waypoints: TrajectoryWaypoint[]): StopGroup[] {
  const groups = new Map<string, StopGroup>();
  waypoints.forEach((w, i) => {
    const key = w.camera_code ?? w.camera_id;
    const g = groups.get(key);
    if (g) g.indices.push(i);
    else groups.set(key, { key, at: [w.lat, w.lng], indices: [i], name: w.camera_name, code: w.camera_code, trip: w.trip_index ?? 0 });
  });
  return [...groups.values()];
}

interface Hop {
  key: string;
  index: number;
  trip: number;
  path: LatLngTuple[];
  arrows: { at: LatLngTuple; bearing: number }[];
  mid: LatLngTuple;
  from?: TrajectoryWaypoint;
  to: TrajectoryWaypoint;
}

function buildHops(waypoints: TrajectoryWaypoint[]): Hop[] {
  const hops: Hop[] = [];
  waypoints.forEach((w, i) => {
    if (!w.path_from_prev || w.path_from_prev.length < 2) return;
    const trip = w.trip_index ?? 0;
    let j = i - 1;
    while (j >= 0 && (waypoints[j].trip_index ?? 0) !== trip) j--;
    const path = w.path_from_prev;
    const cum = cumulativeM(path);
    const total = cum[cum.length - 1];
    const arrows: Hop['arrows'] = [];
    const spacing = total > 6000 ? 1800 : 1200;
    for (let d = spacing * 0.6; d < total - 250 && arrows.length < 8; d += spacing) {
      if (Math.abs(d - total / 2) < 400) continue; // leave room for the hop label
      arrows.push(pointAlong(path, cum, d));
    }
    if (arrows.length === 0) arrows.push(pointAlong(path, cum, total * 0.3));
    hops.push({ key: `${i}`, index: i, trip, path, arrows, mid: pointAlong(path, cum, total / 2).at, from: waypoints[j], to: w });
  });
  return hops;
}

/** Same pair of cameras, in either direction. */
function samePair(a: Hop, b: Hop): boolean {
  const x = [a.from?.camera_code, a.to.camera_code];
  const y = [b.from?.camera_code, b.to.camera_code];
  return (x[0] === y[0] && x[1] === y[1]) || (x[0] === y[1] && x[1] === y[0]);
}

// ── Map children ──

function FitBounds({ points, id }: { points: LatLngTuple[]; id: string }) {
  const map = useMap();
  useEffect(() => {
    if (points.length === 0) return;
    map.fitBounds(L.latLngBounds(points), { padding: [48, 48], maxZoom: 15 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, map]);
  return null;
}

function FocusOnStop({ request, waypoints, reduced }: {
  request: TrajectoryMapProps['focusRequest'];
  waypoints: TrajectoryWaypoint[];
  reduced: boolean;
}) {
  const map = useMap();
  useEffect(() => {
    if (!request) return;
    const w = waypoints[request.index];
    if (!w) return;
    if (reduced) map.setView([w.lat, w.lng], 14, { animate: false });
    else map.flyTo([w.lat, w.lng], 14, { duration: 0.6 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.nonce]);
  return null;
}

const NetworkCameras = memo(function NetworkCameras({ visited, idle, fill }: { visited: Set<string>; idle: string; fill: string }) {
  return (
    <>
      {mockCameras
        .filter((c) => !visited.has(c.code))
        .map((c) => (
          <CircleMarker
            key={c.id}
            center={[c.lat, c.lng]}
            radius={5}
            pathOptions={{ color: idle, weight: 2, fillColor: fill, fillOpacity: 1 }}
          >
            <Tooltip direction="top" offset={[0, -6]}>
              <span className="text-xs font-semibold">{c.name}</span>
              <span className="block text-2xs text-fg-subtle">{c.code} · not on this journey</span>
            </Tooltip>
          </CircleMarker>
        ))}
    </>
  );
});

const HopLayer = memo(function HopLayer({ hops, colorFor, showLabels, casing }: {
  hops: Hop[];
  colorFor: (trip: number) => string;
  showLabels: boolean;
  casing: string;
}) {
  return (
    <>
      {hops.map((h) => (
        <Polyline key={`case-${h.key}`} positions={h.path} pathOptions={{ color: casing, weight: 7, opacity: 0.9, lineCap: 'round', lineJoin: 'round' }} interactive={false} />
      ))}
      {hops.map((h) => {
        const color = colorFor(h.trip);
        return <Polyline key={`line-${h.key}`} positions={h.path} pathOptions={{ color, weight: 4, opacity: 0.95, lineCap: 'round', lineJoin: 'round' }} interactive={false} />;
      })}
      {hops.flatMap((h) =>
        h.arrows.map((a, k) => (
          <Marker key={`arr-${h.key}-${k}`} position={a.at} icon={arrowIcon(a.bearing, colorFor(h.trip))} interactive={false} keyboard={false} />
        )),
      )}
      {showLabels &&
        // Repeated hops on the same road (circling, return trips) share one label: the first pass.
        hops.filter((h, i) => hops.findIndex((o) => samePair(o, h)) === i).map((h) => (
          <Marker
            key={`lbl-${h.key}`}
            position={h.mid}
            interactive={false}
            keyboard={false}
            icon={hopLabelIcon(
              `${formatDistance(h.to.distance_m_from_prev)} · ${formatSpeed(h.to.speed_kmph_from_prev)}`,
              `${h.from ? formatIstHm(h.from.timestamp) : ''}–${formatIstHm(h.to.timestamp)}`,
              colorFor(h.trip),
            )}
          />
        ))}
    </>
  );
});

const StopMarker = memo(function StopMarker({ group, waypoints, color, active, onSelect }: {
  group: StopGroup;
  waypoints: TrajectoryWaypoint[];
  color: string;
  active: boolean;
  onSelect?: (index: number) => void;
}) {
  const label = group.indices.length > 3
    ? `${group.indices[0] + 1}·${group.indices[1] + 1}·…·${group.indices[group.indices.length - 1] + 1}`
    : group.indices.map((i) => i + 1).join('·');
  const handlers = useMemo(() => ({ click: () => onSelect?.(group.indices[0]) }), [group, onSelect]);
  return (
    <Marker position={group.at} icon={stopIcon(label, color, active)} eventHandlers={handlers} zIndexOffset={active ? 1000 : 500}>
      <Tooltip direction="top" offset={[0, -18]}>
        <span className="text-xs font-semibold">{group.name}</span>
        <span className="block font-mono text-2xs text-fg-subtle">
          {group.indices.map((i) => formatIstHm(waypoints[i].timestamp)).join(' · ')}
        </span>
      </Tooltip>
      <Popup>
        <div className="space-y-1 p-1">
          <h4 className="text-[13px] font-semibold text-fg">{group.name}</h4>
          {group.code && <p className="font-mono text-2xs text-fg-subtle">{group.code}</p>}
          {group.indices.map((i) => {
            const w = waypoints[i];
            return (
              <p key={i} className="text-xs tabular-nums text-fg-muted">
                <strong className="text-fg">#{i + 1}</strong> {formatIstTime(w.timestamp)} IST{w.heading ? ` · heading ${w.heading}` : ''}
                {w.speed_kmph_from_prev != null && ` · ${formatSpeed(w.speed_kmph_from_prev)}`}
              </p>
            );
          })}
        </div>
      </Popup>
    </Marker>
  );
});

/** Imperatively moves vehicle marker(s) along the road during a replay. */
function ReplayLayer({ model, playing, speed, seek, visible, colorFor, onTick, onEnd }: {
  model: ReplayModel;
  playing: boolean;
  speed: number;
  seek: { ms: number; nonce: number };
  visible: boolean;
  colorFor: (trip: number) => string;
  onTick: (ms: number) => void;
  onEnd: () => void;
}) {
  const map = useMap();
  const markers = useRef(new Map<number, L.Marker>());
  const msRef = useRef(seek.ms);

  const draw = useCallback(() => {
    const live = markers.current;
    if (!visible) {
      live.forEach((m) => m.remove());
      live.clear();
      return;
    }
    const positions = positionsAt(model, realTimeAt(model, msRef.current));
    const seen = new Set<number>();
    for (const p of positions) {
      seen.add(p.trip);
      const m = live.get(p.trip);
      if (m) {
        m.setLatLng(p.at);
        const icon = vehicleIcon(colorFor(p.trip));
        if (m.options.icon !== icon) m.setIcon(icon); // theme switched mid-replay
      } else live.set(p.trip, L.marker(p.at, { icon: vehicleIcon(colorFor(p.trip)), interactive: false, keyboard: false, zIndexOffset: 2000 }).addTo(map));
    }
    live.forEach((m, trip) => {
      if (!seen.has(trip)) {
        m.remove();
        live.delete(trip);
      }
    });
  }, [model, visible, colorFor, map]);

  useEffect(() => {
    msRef.current = seek.ms;
    draw();
  }, [seek, draw]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      msRef.current = Math.min(model.duration, msRef.current + (now - last) * speed);
      last = now;
      draw();
      onTick(msRef.current);
      if (msRef.current >= model.duration) {
        onEnd();
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, model, draw, onTick, onEnd]);

  useEffect(() => {
    const live = markers.current;
    return () => {
      live.forEach((m) => m.remove());
      live.clear();
    };
  }, [model, map]);

  return null;
}

// ── Main component ──

export function TrajectoryMap({ trajectory, activeIndex = null, onActiveIndexChange, focusRequest = null, className = '' }: TrajectoryMapProps) {
  const reduced = usePrefersReducedMotion();
  const tokens = useThemeTokens();
  const waypoints = trajectory.waypoints;

  const colorFor = useMemo(() => tripColors(trajectory, tokens.series, tokens.danger), [trajectory, tokens]);
  const groups = useMemo(() => groupStops(waypoints), [waypoints]);
  const hops = useMemo(() => buildHops(waypoints), [waypoints]);
  const visited = useMemo(() => new Set(waypoints.map((w) => w.camera_code ?? '')), [waypoints]);
  const boundsPoints = useMemo<LatLngTuple[]>(
    () => [...waypoints.map((w) => [w.lat, w.lng] as LatLngTuple), ...hops.flatMap((h) => h.path)],
    [waypoints, hops],
  );
  const model = useMemo(() => buildReplayModel(waypoints), [waypoints]);
  const canReplay = waypoints.length > 1;

  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const [seek, setSeek] = useState({ ms: 0, nonce: 0 });
  const [progressMs, setProgressMs] = useState(0);
  const currentMs = useRef(0);
  const lastUiUpdate = useRef(0);
  const lastStop = useRef(-1);

  const seekTo = (ms: number) => {
    currentMs.current = ms;
    setProgressMs(ms);
    setSeek((prev) => ({ ms, nonce: prev.nonce + 1 }));
  };

  const onTick = useCallback((ms: number) => {
    currentMs.current = ms;
    const now = performance.now();
    const t = realTimeAt(model, ms);
    const stop = stopIndexAt(model, t);
    if (stop !== lastStop.current && stop >= 0) {
      lastStop.current = stop;
      onActiveIndexChange?.(stop);
    }
    if (now - lastUiUpdate.current > 100 || ms >= model.duration) {
      lastUiUpdate.current = now;
      setProgressMs(ms);
    }
  }, [model, onActiveIndexChange]);

  const onEnd = useCallback(() => setPlaying(false), []);

  const seekToStop = useCallback((index: number) => {
    const w = waypoints[index];
    if (!w) return;
    setStarted(true);
    seekTo(replayMsAt(model, Date.parse(w.timestamp)));
    lastStop.current = index;
    onActiveIndexChange?.(index);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waypoints, model, onActiveIndexChange]);

  // Timeline click → move the replay vehicle to that stop too.
  useEffect(() => {
    if (focusRequest && started && !playing) seekToStop(focusRequest.index);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.nonce]);

  const togglePlay = () => {
    if (reduced) return;
    if (playing) {
      setPlaying(false);
      seekTo(currentMs.current);
      return;
    }
    const from = currentMs.current >= model.duration ? 0 : currentMs.current;
    if (from === 0) {
      lastStop.current = -1;
      onActiveIndexChange?.(0);
    }
    seekTo(from);
    setStarted(true);
    setPlaying(true);
  };

  const restart = () => {
    setPlaying(false);
    seekTo(0);
    setStarted(false);
    lastStop.current = -1;
  };

  const step = (dir: 1 | -1) => {
    setPlaying(false);
    const base = activeIndex ?? (dir === 1 ? -1 : waypoints.length);
    const next = Math.max(0, Math.min(waypoints.length - 1, base + dir));
    seekToStop(next);
  };

  const scrub = (ms: number) => {
    setStarted(true);
    seekTo(ms);
    const stop = stopIndexAt(model, realTimeAt(model, ms));
    if (stop >= 0 && stop !== lastStop.current) {
      lastStop.current = stop;
      onActiveIndexChange?.(stop);
    }
  };

  /** `[` / `]` step through stops, Space plays/pauses — while the map area has focus. */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const tag = (e.target as HTMLElement).tagName;
    if (!canReplay || tag === 'INPUT' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'TEXTAREA') return;
    if (e.key === '[') step(-1);
    else if (e.key === ']') step(1);
    else if (e.key === ' ' && !reduced) togglePlay();
    else return;
    e.preventDefault();
  };

  const trips = useMemo(() => [...new Set(waypoints.map((w) => w.trip_index ?? 0))].sort((a, b) => a - b), [waypoints]);
  const hasClone = trajectory.anomalies?.some((a) => a.kind === 'cloned_plate') ?? false;
  const legend: LegendItem[] = [
    ...trips.slice(0, 6).map((t): LegendItem => {
      const c = colorFor(t);
      return { label: c === tokens.danger ? `Trip ${t + 1} (suspect)` : trips.length > 1 ? `Trip ${t + 1}` : 'Journey', color: c, shape: 'line' };
    }),
    { label: 'Stop (visit order)', color: tokens.series[0], shape: 'dot' },
    { label: 'Direction of travel', color: tokens.fgMuted, shape: 'arrow' },
    { label: 'Camera not on journey', color: tokens.map.camIdle, shape: 'ring' },
    ...(hasClone && !trips.some((t) => colorFor(t) === tokens.danger) ? [{ label: 'Anomaly', color: tokens.danger, shape: 'line' as const }] : []),
  ];

  if (waypoints.length === 0) return null;
  const clock = started ? formatIstTime(realTimeAt(model, progressMs)) : formatIstTime(waypoints[0].timestamp);

  return (
    <div className={`relative h-full w-full ${className}`} onKeyDown={onKeyDown}>
      <MapContainer center={[waypoints[0].lat, waypoints[0].lng]} zoom={12} className="h-full w-full" zoomControl={false} style={{ background: 'var(--map-bg)' }}>
        <BaseTileLayer />
        <ZoomControl position="topright" />
        <FitBounds points={boundsPoints} id={trajectory.id} />
        <FocusOnStop request={focusRequest} waypoints={waypoints} reduced={reduced} />
        <NetworkCameras visited={visited} idle={tokens.map.camIdle} fill={tokens.surface} />
        <HopLayer hops={hops} colorFor={colorFor} showLabels={hops.length <= 12} casing={tokens.map.markerHalo} />
        {groups.map((g) => (
          <StopMarker
            key={g.key}
            group={g}
            waypoints={waypoints}
            color={colorFor(g.trip)}
            active={activeIndex != null && g.indices.includes(activeIndex)}
            onSelect={onActiveIndexChange}
          />
        ))}
        {canReplay && (
          <ReplayLayer
            model={model}
            playing={playing && !reduced}
            speed={speed}
            seek={seek}
            visible={started}
            colorFor={colorFor}
            onTick={onTick}
            onEnd={onEnd}
          />
        )}
      </MapContainer>

      <MapLegend title="Legend" position="top-left" items={legend} />

      {trajectory.source === 'simulation' && (
        <MapPanel position="top-right" className="pointer-events-none mr-14 hidden p-1 sm:block">
          <SimulationBadge compact />
        </MapPanel>
      )}

      {canReplay && (
        <MapPanel position="bottom-center" className="w-[min(460px,calc(100%-24px))] px-2 py-1.5">
          <div className="flex flex-wrap items-center gap-1 sm:flex-nowrap" role="group" aria-label="Journey replay controls">
            {!reduced && (
              <IconButton
                size="sm"
                variant="primary"
                label={playing ? 'Pause replay' : 'Replay journey'}
                icon={playing ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
                onClick={togglePlay}
              />
            )}
            <IconButton size="sm" label="Previous stop" icon={<SkipBackIcon size={14} />} onClick={() => step(-1)} />
            <IconButton size="sm" variant={reduced ? 'primary' : 'ghost'} label="Next stop" icon={<SkipForwardIcon size={14} />} onClick={() => step(1)} />
            {!reduced && <IconButton size="sm" label="Reset replay" icon={<RotateCcwIcon size={14} />} onClick={restart} />}
            <input
              type="range"
              min={0}
              max={Math.round(model.duration)}
              step={1}
              value={Math.round(progressMs)}
              onChange={(e) => scrub(Number(e.target.value))}
              aria-label="Replay position"
              aria-valuetext={`${clock} IST`}
              className="mx-1 h-1 min-w-0 flex-1 cursor-pointer accent-[var(--primary)] max-sm:order-last max-sm:mx-0 max-sm:basis-[calc(100%-5.5rem)]"
            />
            <span className="shrink-0 font-mono text-xs font-medium tabular-nums text-fg max-sm:ml-auto" aria-live="off">{clock} IST</span>
            {!reduced && (
              <select
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
                aria-label="Replay speed"
                className="ml-1 h-7 shrink-0 max-sm:order-last max-sm:ml-auto cursor-pointer rounded-sm border border-line-strong bg-surface px-1 text-xs tabular-nums text-fg touch:h-10"
              >
                {REPLAY_SPEEDS.map((s) => (
                  <option key={s} value={s}>{s}×</option>
                ))}
              </select>
            )}
          </div>
        </MapPanel>
      )}
    </div>
  );
}
