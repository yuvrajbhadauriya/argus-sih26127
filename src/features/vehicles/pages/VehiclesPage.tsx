// ═══════════════════════════════════════════════════
// VehiclesPage — Trajectory Reconstruction Engine
// Query a plate → chronological multi-camera journey on the Delhi road map,
// synced timeline, totals and anomaly flags.
// ═══════════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  SearchIcon,
  CarIcon,
  NavigationIcon,
  ClockIcon,
  RouteIcon,
  GaugeIcon,
  CameraIcon,
  TimerIcon,
  TriangleAlertIcon,
  SparklesIcon,
} from 'lucide-react';
import type { Trajectory, Vehicle } from '@/types';
import { searchVehicles, fetchTrajectoryByPlate } from '@/features/vehicles/api';
import { getPlateSuggestions, type PlateSuggestion } from '@/features/vehicles/sim';
import { formatDistance, formatDuration, formatIstDate, formatIstHm, formatSpeed, normalizePlate } from '@/features/vehicles/lib/geo';
import { Card, CardHeader } from '@/shared/ui/Card';
import { LoadingState } from '@/shared/ui/LoadingState';
import { EmptyState } from '@/shared/ui/EmptyState';
import { TrajectoryMap } from '@/features/vehicles/components/TrajectoryMap';
import { TrajectoryTimeline } from '@/features/vehicles/components/TrajectoryTimeline';
import { SimulationBadge } from '@/features/vehicles/components/SimulationBadge';

const CHIP_STYLE: Record<PlateSuggestion['kind'], string> = {
  watchlist: 'border-amber-400/40 text-amber-200 hover:border-amber-300',
  anomaly: 'border-rose-500/40 text-rose-300 hover:border-rose-400',
  'multi-camera': 'border-nero-border text-nero-text-secondary hover:border-nero-accent/50 hover:text-nero-text-primary',
};

function StatTile({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-nero-border bg-nero-surface px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-nero-text-muted">
        {icon}
        {label}
      </div>
      <div className="mt-1 font-mono text-base font-bold text-nero-text-primary">{value}</div>
      {hint && <div className="text-[10px] text-nero-text-muted">{hint}</div>}
    </div>
  );
}

export function VehiclesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlPlate = searchParams.get('plate') || '';

  const [query, setQuery] = useState(urlPlate);
  const [matches, setMatches] = useState<Vehicle[]>([]);
  const [showMatches, setShowMatches] = useState(false);
  const [suggestions, setSuggestions] = useState<PlateSuggestion[]>([]);
  const [selectedPlate, setSelectedPlate] = useState<string | null>(urlPlate || null);
  const [result, setResult] = useState<{ plate: string; trajectory: Trajectory | null; message: string | null } | null>(null);
  const [pickMessage, setPickMessage] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ index: number; nonce: number } | null>(null);
  const searchSeq = useRef(0);

  // Demo plate chips (watchlist first) from the simulated network.
  useEffect(() => {
    let alive = true;
    getPlateSuggestions(10)
      .then((s) => {
        if (!alive) return;
        setSuggestions(s);
        setSelectedPlate((cur) => cur ?? s[0]?.plate_text ?? null);
      })
      .catch((err) => console.warn('No simulated plate suggestions:', err));
    return () => {
      alive = false;
    };
  }, []);

  // Load the trajectory for the selected plate.
  useEffect(() => {
    if (!selectedPlate) return;
    let alive = true;
    fetchTrajectoryByPlate(selectedPlate)
      .then((t) => {
        if (alive) setResult({ plate: selectedPlate, trajectory: t, message: t ? null : `No camera sightings found for ${selectedPlate}.` });
      })
      .catch((err) => {
        if (alive) setResult({ plate: selectedPlate, trajectory: null, message: err instanceof Error ? err.message : 'Failed to reconstruct trajectory' });
      });
    return () => {
      alive = false;
    };
  }, [selectedPlate]);

  const loading = selectedPlate != null && result?.plate !== selectedPlate;
  const trajectory = loading ? null : result?.trajectory ?? null;
  const message = pickMessage ?? (loading ? null : result?.message ?? null);

  // Live plate matches while typing (debounced).
  const typed = normalizePlate(query);
  const wantMatches = typed.length >= 3 && !(trajectory && normalizePlate(trajectory.plate_text) === typed);
  useEffect(() => {
    if (!wantMatches) return;
    const seq = ++searchSeq.current;
    const handle = setTimeout(() => {
      searchVehicles(query)
        .then((res) => seq === searchSeq.current && setMatches(res.slice(0, 8)))
        .catch(() => seq === searchSeq.current && setMatches([]));
    }, 200);
    return () => clearTimeout(handle);
  }, [query, wantMatches]);
  const visibleMatches = wantMatches || pickMessage ? matches : [];

  const selectPlate = useCallback((plate: string) => {
    setSelectedPlate(plate);
    setActiveIndex(null);
    setPickMessage(null);
    setQuery(plate);
    setShowMatches(false);
    setMatches([]);
    setSearchParams({ plate });
  }, [setSearchParams]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = normalizePlate(query);
    if (!q) return;
    const seq = ++searchSeq.current;
    const res = await searchVehicles(query).catch(() => [] as Vehicle[]);
    if (seq !== searchSeq.current) return;
    const exact = res.find((v) => normalizePlate(v.plate_text) === q);
    if (exact || res.length === 1) {
      selectPlate((exact ?? res[0]).plate_text);
    } else if (res.length > 1) {
      setMatches(res.slice(0, 8));
      setShowMatches(true);
      setPickMessage(`${res.length} vehicles match “${query.trim()}” — pick one from the list.`);
    } else {
      // Unknown to the vehicle index — still try a direct trajectory lookup.
      selectPlate(query.trim().toUpperCase());
    }
  };

  const handleTimelineSelect = useCallback((index: number) => {
    setActiveIndex(index);
    setFocusRequest((prev) => ({ index, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  const chip = useMemo(() => {
    if (!trajectory) return null;
    const n = normalizePlate(trajectory.plate_text);
    return suggestions.find((s) => normalizePlate(s.plate_text) === n) ?? null;
  }, [trajectory, suggestions]);

  const avgSpeed = trajectory?.moving_time_seconds
    ? (trajectory.total_distance_m ?? 0) / trajectory.moving_time_seconds * 3.6
    : null;
  const isSim = trajectory?.source === 'simulation';

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col justify-between gap-3 md:flex-row md:items-end">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-black tracking-tight text-nero-text-primary">Vehicle Trajectory Reconstruction</h1>
            <span className="flex items-center gap-1.5 rounded-full border border-nero-accent/30 bg-nero-accent/15 px-3 py-0.5 text-xs font-bold text-nero-accent">
              <SparklesIcon size={12} />
              Multi-camera ANPR
            </span>
            {(isSim || (!trajectory && suggestions.length > 0)) && <SimulationBadge />}
          </div>
          <p className="mt-1 text-xs text-nero-text-muted">
            Query a number plate to plot its chronological path across the city camera network — timestamps, direction and road route.
          </p>
        </div>
      </div>

      {/* Search */}
      <Card className="nero-card border-nero-border/80">
        <form onSubmit={handleSubmit} className="flex flex-col gap-3 sm:flex-row" role="search">
          <div className="relative flex-1">
            <SearchIcon size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-nero-text-muted" />
            <input
              type="text"
              aria-label="Licence plate"
              placeholder="Enter a plate, e.g. DL 04 RS 9598 or dl04rs9598"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setShowMatches(true);
              }}
              onFocus={() => setShowMatches(true)}
              onBlur={() => setTimeout(() => setShowMatches(false), 150)}
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-xl border border-nero-border bg-nero-bg/80 py-2.5 pl-11 pr-4 font-mono text-xs uppercase text-nero-text-primary transition-all placeholder:font-sans placeholder:normal-case placeholder:text-nero-text-muted focus:border-nero-accent focus:bg-nero-bg focus:outline-none focus:ring-2 focus:ring-nero-accent/20"
            />
            {showMatches && visibleMatches.length > 0 && (
              <ul className="absolute left-0 right-0 top-full z-[1100] mt-1 overflow-hidden rounded-xl border border-nero-border bg-nero-surface-elevated shadow-2xl" role="listbox">
                {visibleMatches.map((v) => (
                  <li key={v.plate_text}>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => selectPlate(v.plate_text)}
                      className="flex w-full items-center justify-between gap-3 px-4 py-2 text-left hover:bg-nero-surface-hover"
                    >
                      <span className="font-mono text-xs font-bold text-nero-text-primary">{v.plate_text}</span>
                      <span className="text-[10px] text-nero-text-muted">
                        {v.vehicle_type} · {v.camera_count} camera{v.camera_count === 1 ? '' : 's'} · {v.detection_count} sightings
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button
            type="submit"
            className="rounded-xl bg-nero-accent px-6 py-2.5 text-xs font-bold text-nero-bg transition-all hover:bg-nero-accent-hover hover:shadow-lg hover:shadow-nero-accent/25"
          >
            Trace Journey
          </button>
        </form>

        {suggestions.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium text-nero-text-muted">Try:</span>
            {suggestions.map((s) => {
              const active = selectedPlate != null && normalizePlate(selectedPlate) === normalizePlate(s.plate_text);
              return (
                <button
                  key={s.plate_text}
                  type="button"
                  onClick={() => selectPlate(s.plate_text)}
                  className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 font-mono text-[11px] font-bold transition-colors ${
                    active ? 'border-nero-accent bg-nero-accent text-nero-bg' : `bg-nero-surface/80 ${CHIP_STYLE[s.kind]}`
                  }`}
                >
                  {s.plate_text}
                  {s.kind !== 'multi-camera' && (
                    <span className={`font-sans text-[9px] font-semibold uppercase ${active ? 'text-nero-bg/80' : 'opacity-80'}`}>{s.label}</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </Card>

      {/* Anomalies */}
      {trajectory?.anomalies && trajectory.anomalies.length > 0 && (
        <div className="space-y-2">
          {trajectory.anomalies.map((a) => (
            <div key={a.kind} role="alert" className="flex items-start gap-3 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3">
              <TriangleAlertIcon size={18} className="mt-0.5 shrink-0 text-rose-400" />
              <div>
                <div className="text-xs font-bold uppercase tracking-wide text-rose-300">
                  {a.kind === 'cloned_plate' ? 'Possible cloned plate' : a.kind === 'circling' ? 'Suspicious circling' : 'Anomaly'}
                </div>
                <p className="mt-0.5 text-xs text-nero-text-secondary">{a.message}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Map + totals */}
        <div className="space-y-4 lg:col-span-2">
          <Card className="relative h-[520px] overflow-hidden rounded-2xl border-nero-border/80 p-0 shadow-2xl">
            {loading ? (
              <LoadingState message="Reconstructing journey across camera network..." />
            ) : trajectory && trajectory.waypoints.length > 0 ? (
              <TrajectoryMap
                key={trajectory.id}
                trajectory={trajectory}
                activeIndex={activeIndex}
                onActiveIndexChange={setActiveIndex}
                focusRequest={focusRequest}
              />
            ) : (
              <EmptyState
                icon={<NavigationIcon size={32} />}
                title={message ? 'No trajectory found' : 'Search a vehicle plate'}
                description={message ?? 'Enter a licence plate above, or pick one of the demo plates, to trace its journey across the city.'}
              />
            )}
          </Card>

          {trajectory && trajectory.waypoints.length > 0 && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <StatTile icon={<RouteIcon size={12} />} label="Road distance" value={formatDistance(trajectory.total_distance_m ?? null)} />
              <StatTile icon={<TimerIcon size={12} />} label="Time moving" value={formatDuration(trajectory.moving_time_seconds ?? null)} />
              <StatTile icon={<GaugeIcon size={12} />} label="Avg speed" value={formatSpeed(avgSpeed)} />
              <StatTile icon={<CameraIcon size={12} />} label="Cameras" value={`${trajectory.camera_count}`} hint={`${trajectory.waypoints.length} sightings`} />
              <StatTile
                icon={<ClockIcon size={12} />}
                label="Observed"
                value={`${formatIstHm(trajectory.first_seen)}–${formatIstHm(trajectory.last_seen)}`}
                hint={`${formatIstDate(trajectory.first_seen)} · IST`}
              />
            </div>
          )}
        </div>

        {/* Summary + timeline */}
        <div className="space-y-4">
          {trajectory && (
            <Card className="nero-card">
              <CardHeader title="Target Summary" subtitle="ANPR track record" action={<CarIcon size={18} className="text-nero-accent" />} />
              <dl className="my-2 space-y-2.5 text-xs">
                <div className="flex items-center justify-between border-b border-nero-border/60 pb-2">
                  <dt className="text-nero-text-muted">Licence plate</dt>
                  <dd className="font-mono text-sm font-bold text-nero-accent">{trajectory.plate_text}</dd>
                </div>
                <div className="flex items-center justify-between border-b border-nero-border/60 pb-2">
                  <dt className="text-nero-text-muted">Vehicle class</dt>
                  <dd className="font-bold uppercase text-nero-text-primary">{trajectory.vehicle_type}</dd>
                </div>
                {chip && chip.kind !== 'multi-camera' && (
                  <div className="flex items-center justify-between border-b border-nero-border/60 pb-2">
                    <dt className="text-nero-text-muted">Status</dt>
                    <dd className={`font-bold ${chip.kind === 'anomaly' ? 'text-rose-400' : 'text-amber-300'}`}>
                      {chip.kind === 'watchlist' ? `Watchlist · ${chip.label}` : chip.label}
                    </dd>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <dt className="text-nero-text-muted">Data source</dt>
                  <dd className="text-nero-text-secondary">
                    {trajectory.source === 'supabase' ? 'Live detections (Supabase)' : isSim ? <SimulationBadge compact /> : 'Sample data'}
                  </dd>
                </div>
              </dl>
            </Card>
          )}

          <Card className="nero-card">
            <CardHeader title="Journey Timeline" subtitle="Chronological camera sightings" action={<ClockIcon size={16} className="text-nero-text-muted" />} />
            <div className="mt-2 max-h-[520px] overflow-y-auto pr-1">
              {trajectory && trajectory.waypoints.length > 0 ? (
                <TrajectoryTimeline trajectory={trajectory} activeIndex={activeIndex} onSelect={handleTimelineSelect} />
              ) : (
                <p className="py-8 text-center text-xs text-nero-text-muted">Select a vehicle plate to view its camera sightings.</p>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

export default VehiclesPage;
