// ═══════════════════════════════════════════════════
// TrajectoryMap Component
// Road-snapped journey path, numbered stops in time order, direction arrows,
// per-hop time/speed/distance labels and an animated replay.
// ═══════════════════════════════════════════════════

import { MapContainer, Polyline, Marker, Popup, Tooltip, CircleMarker, useMap } from 'react-leaflet';
import L from 'leaflet';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PauseIcon, PlayIcon, RotateCcwIcon, SkipBackIcon, SkipForwardIcon } from 'lucide-react';
import type { Trajectory, TrajectoryWaypoint } from '@/types';
import { BaseTileLayer } from '@/shared/map/BaseTileLayer';
import { mockCameras } from '@/mocks/fixtures/mockCameras';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';
import { cumulativeM, formatDistance, formatIstHm, formatIstTime, formatSpeed, pointAlong, type LatLngTuple } from '../lib/geo';
import { buildReplayModel, positionsAt, realTimeAt, replayMsAt, stopIndexAt, type ReplayModel } from '../lib/replay';
import { tripColors } from '../lib/colors';
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
    const size = active ? 34 : 28;
    const wide = label.length > 2;
    return L.divIcon({
      className: 'trajectory-stop-icon',
      html: `<div style="min-width:${size}px;height:${size}px;padding:0 ${wide ? 8 : 0}px;background:${color};color:#000;
        border:2px solid ${active ? '#fff' : '#000'};border-radius:9999px;display:flex;align-items:center;justify-content:center;
        font:800 ${active ? 13 : 12}px/1 Inter,system-ui,sans-serif;box-shadow:0 0 ${active ? 18 : 10}px ${color}b3;
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
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 3 L20 20 L12 15 L4 20 Z" fill="${color}" stroke="#000" stroke-width="1.5" stroke-linejoin="round"/></svg></div>`,
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
        background:rgba(10,10,10,.88);border:1px solid ${color}66;border-radius:8px;padding:3px 7px;color:#e4e4e7;
        font:600 10px/1.35 Inter,system-ui,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.5)">
        <div style="color:${color}">${text}</div><div style="color:#a1a1aa;font-weight:500">${sub}</div></div>`,
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
        background:${color};border:3px solid #fff;box-shadow:0 0 0 6px ${color}40,0 0 18px ${color}"></div>`,
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

const NetworkCameras = memo(function NetworkCameras({ visited }: { visited: Set<string> }) {
  return (
    <>
      {mockCameras
        .filter((c) => !visited.has(c.code))
        .map((c) => (
          <CircleMarker
            key={c.id}
            center={[c.lat, c.lng]}
            radius={5}
            pathOptions={{ color: '#71717a', weight: 1.5, fillColor: '#27272a', fillOpacity: 0.9 }}
          >
            <Tooltip direction="top" offset={[0, -6]}>
              <span className="text-xs font-semibold">{c.name}</span>
              <span className="block text-[10px] text-zinc-500">{c.code} · not on this journey</span>
            </Tooltip>
          </CircleMarker>
        ))}
    </>
  );
});

const HopLayer = memo(function HopLayer({ hops, colorFor, showLabels }: {
  hops: Hop[];
  colorFor: (trip: number) => string;
  showLabels: boolean;
}) {
  return (
    <>
      {hops.map((h) => {
        const color = colorFor(h.trip);
        return (
          <Polyline key={`glow-${h.key}`} positions={h.path} pathOptions={{ color, weight: 10, opacity: 0.16, lineCap: 'round' }} interactive={false} />
        );
      })}
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
        // Repeated hops (e.g. a vehicle circling) share one label: the first pass.
        hops.filter((h, i) => hops.findIndex((o) => o.from?.camera_code === h.from?.camera_code && o.to.camera_code === h.to.camera_code) === i).map((h) => (
          <Marker
            key={`lbl-${h.key}`}
            position={h.mid}
            interactive={false}
            keyboard={false}
            icon={hopLabelIcon(
              `${formatDistance(h.to.distance_m_from_prev)} · ${formatSpeed(h.to.speed_kmph_from_prev)}`,
              `${h.from ? formatIstHm(h.from.timestamp) : ''} → ${formatIstHm(h.to.timestamp)}`,
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
        <span className="text-xs font-bold">{group.name}</span>
        <span className="block text-[10px] text-zinc-500">
          {group.indices.map((i) => formatIstHm(waypoints[i].timestamp)).join(' · ')}
        </span>
      </Tooltip>
      <Popup>
        <div className="space-y-1 p-1">
          <h4 className="text-sm font-bold">{group.name}</h4>
          {group.code && <p className="font-mono text-[10px] text-zinc-500">{group.code}</p>}
          {group.indices.map((i) => {
            const w = waypoints[i];
            return (
              <p key={i} className="text-xs">
                <strong>#{i + 1}</strong> {formatIstTime(w.timestamp)} IST{w.heading ? ` · heading ${w.heading}` : ''}
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
function ReplayLayer({ model, playing, seek, visible, colorFor, onTick, onEnd }: {
  model: ReplayModel;
  playing: boolean;
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
      if (m) m.setLatLng(p.at);
      else live.set(p.trip, L.marker(p.at, { icon: vehicleIcon(colorFor(p.trip)), interactive: false, keyboard: false, zIndexOffset: 2000 }).addTo(map));
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
      msRef.current = Math.min(model.duration, msRef.current + (now - last));
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
  }, [playing, model, draw, onTick, onEnd]);

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
  const waypoints = trajectory.waypoints;

  const colorFor = useMemo(() => tripColors(trajectory), [trajectory]);
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
    const base = activeIndex ?? (dir === 1 ? -1 : waypoints.length);
    const next = Math.max(0, Math.min(waypoints.length - 1, base + dir));
    seekToStop(next);
  };

  if (waypoints.length === 0) return null;
  const clock = started ? formatIstTime(realTimeAt(model, progressMs)) : formatIstTime(waypoints[0].timestamp);
  const pct = Math.min(100, (progressMs / model.duration) * 100);

  return (
    <div className={`relative h-full w-full ${className}`}>
      <MapContainer center={[waypoints[0].lat, waypoints[0].lng]} zoom={12} className="h-full w-full rounded-xl" zoomControl={true}>
        <BaseTileLayer />
        <FitBounds points={boundsPoints} id={trajectory.id} />
        <FocusOnStop request={focusRequest} waypoints={waypoints} reduced={reduced} />
        <NetworkCameras visited={visited} />
        <HopLayer hops={hops} colorFor={colorFor} showLabels={hops.length <= 12} />
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
            seek={seek}
            visible={started}
            colorFor={colorFor}
            onTick={onTick}
            onEnd={onEnd}
          />
        )}
      </MapContainer>

      {trajectory.source === 'simulation' && (
        <div className="pointer-events-none absolute right-3 top-3 z-[1000]">
          <SimulationBadge compact className="bg-black/70 backdrop-blur" />
        </div>
      )}

      {canReplay && (
        <div className="absolute bottom-3 left-3 right-3 z-[1000] flex items-center gap-3 rounded-xl border border-nero-border bg-nero-bg/85 px-3 py-2 backdrop-blur sm:right-auto sm:w-[380px]">
          {reduced ? (
            <>
              <button type="button" onClick={() => step(-1)} aria-label="Previous stop" className="rounded-lg border border-nero-border p-1.5 text-nero-text-secondary hover:text-nero-accent">
                <SkipBackIcon size={14} />
              </button>
              <button type="button" onClick={() => step(1)} aria-label="Next stop" className="rounded-lg bg-nero-accent p-1.5 text-nero-bg hover:bg-nero-accent-hover">
                <SkipForwardIcon size={14} />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={togglePlay}
                aria-label={playing ? 'Pause replay' : 'Replay journey'}
                className="rounded-lg bg-nero-accent p-1.5 text-nero-bg transition-colors hover:bg-nero-accent-hover"
              >
                {playing ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
              </button>
              <button type="button" onClick={restart} aria-label="Reset replay" className="rounded-lg border border-nero-border p-1.5 text-nero-text-secondary hover:text-nero-accent">
                <RotateCcwIcon size={14} />
              </button>
            </>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-nero-text-muted">
                {reduced ? 'Step through stops' : 'Journey replay'}
              </span>
              <span className="font-mono text-[11px] font-bold text-nero-text-primary">{clock} IST</span>
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-nero-border" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
              <div className="h-full rounded-full bg-nero-accent" style={{ width: `${pct}%` }} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
