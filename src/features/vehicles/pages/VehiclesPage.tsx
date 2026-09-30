// ═══════════════════════════════════════════════════
// VehiclesPage — Vehicle Trace (trajectory reconstruction)
// Query a plate → chronological multi-camera journey on the Mumbai road map,
// synced timeline, totals and anomaly flags. The plate lives in `?plate=`,
// so the global top-bar search and deep links from Alerts/Detections work
// even while this page is already open.
// ═══════════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  CameraIcon,
  ClockIcon,
  CopyIcon,
  GaugeIcon,
  ListOrderedIcon,
  MapPinIcon,
  NavigationIcon,
  RepeatIcon,
  RouteIcon,
  SearchIcon,
  TimerIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import type { Trajectory, Vehicle } from '@/types';
import { searchVehicles, fetchTrajectoryByPlate } from '@/features/vehicles/api';
import { getPlateSuggestions, type PlateSuggestion } from '@/features/vehicles/sim';
import { formatDistance, formatDuration, formatIstDate, formatIstHm, formatIstTime, formatSpeed, normalizePlate } from '@/features/vehicles/lib/geo';
import { formatPlate, plateVariantOf } from '@/shared/lib/plate';
import { Page, PageHeader } from '@/shared/layout/Page';
import { Panel } from '@/shared/ui/Card';
import { Badge } from '@/shared/ui/Badge';
import { Button } from '@/shared/ui/Button';
import { Input } from '@/shared/ui/Input';
import { KpiStrip, KpiTile } from '@/shared/ui/KpiTile';
import { PlateChip } from '@/shared/ui/PlateChip';
import { SeverityChip } from '@/shared/ui/SeverityChip';
import { Skeleton, SkeletonPanel } from '@/shared/ui/Skeleton';
import { EmptyState } from '@/shared/ui/EmptyState';
import { ErrorState } from '@/shared/ui/ErrorState';
import { cn } from '@/shared/lib/cn';
import { TrajectoryMap } from '@/features/vehicles/components/TrajectoryMap';
import { TrajectoryTimeline } from '@/features/vehicles/components/TrajectoryTimeline';
import { SimulationBadge } from '@/features/vehicles/components/SimulationBadge';

const MAP_HEIGHT = 'h-[max(520px,calc(100dvh-330px))]';
const RAIL_MAX_H = 'max-h-[max(520px,calc(100dvh-330px))]';

const ANOMALY_TITLE: Record<string, string> = {
  cloned_plate: 'Possible cloned plate',
  circling: 'Suspicious circling',
};

type LoadResult = { plate: string; trajectory: Trajectory | null; error: string | null };

const flagOf = (s: PlateSuggestion) => (s.kind === 'watchlist' ? 'watchlist' : s.kind === 'anomaly' ? 'anomaly' : null);

function SuggestionChips({ suggestions, selectedPlate, onPick, className }: {
  suggestions: PlateSuggestion[];
  selectedPlate: string | null;
  onPick: (plate: string) => void;
  className?: string;
}) {
  if (suggestions.length === 0) return null;
  return (
    <div className={cn('-mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-1 sm:flex-wrap sm:overflow-visible sm:pb-0', className)}>
      <span className="shrink-0 text-xs font-medium text-fg-muted">Suggested:</span>
      {suggestions.map((s) => {
        const active = selectedPlate != null && normalizePlate(selectedPlate) === normalizePlate(s.plate_text);
        return (
          <button
            key={s.plate_text}
            type="button"
            onClick={() => onPick(s.plate_text)}
            aria-pressed={active}
            aria-label={`${formatPlate(s.plate_text)}${s.kind !== 'multi-camera' ? ` · ${s.label}` : ''}`}
            title={s.reason}
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 rounded-sm border px-1 py-0.5 transition-colors',
              active ? 'border-primary bg-primary/12' : 'border-transparent hover:bg-surface-2',
            )}
          >
            <PlateChip plate={s.plate_text} size="sm" flag={flagOf(s)} />
            {s.kind !== 'multi-camera' && (
              <Badge tone={s.kind === 'anomaly' ? 'danger' : 'warning'}>{s.label}</Badge>
            )}
          </button>
        );
      })}
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="text-right text-xs text-fg">{children}</dd>
    </div>
  );
}

export function VehiclesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlPlate = searchParams.get('plate') || '';

  const [query, setQuery] = useState(urlPlate ? formatPlate(urlPlate) : '');
  const [matches, setMatches] = useState<Vehicle[]>([]);
  const [showMatches, setShowMatches] = useState(false);
  const [suggestions, setSuggestions] = useState<PlateSuggestion[]>([]);
  const [selectedPlate, setSelectedPlate] = useState<string | null>(urlPlate || null);
  const [result, setResult] = useState<LoadResult | null>(null);
  const [pickMessage, setPickMessage] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ index: number; nonce: number } | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const searchSeq = useRef(0);

  // Follow `?plate=` changes (global search, back/forward, deep links) —
  // adjusted during render so the new plate never flashes the old journey.
  const [syncedUrlPlate, setSyncedUrlPlate] = useState(urlPlate);
  if (urlPlate !== syncedUrlPlate) {
    setSyncedUrlPlate(urlPlate);
    if (urlPlate && normalizePlate(urlPlate) !== normalizePlate(selectedPlate ?? '')) {
      setSelectedPlate(urlPlate);
      setQuery(formatPlate(urlPlate));
      setActiveIndex(null);
      setPickMessage(null);
      setShowMatches(false);
    }
  }

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
        if (alive) setResult({ plate: selectedPlate, trajectory: t, error: null });
      })
      .catch((err) => {
        if (alive) setResult({ plate: selectedPlate, trajectory: null, error: err instanceof Error ? err.message : 'Failed to reconstruct trajectory' });
      });
    return () => {
      alive = false;
    };
  }, [selectedPlate, retryNonce]);

  const loading = selectedPlate != null && result?.plate !== selectedPlate;
  const current = loading ? null : result;
  const trajectory = current?.trajectory ?? null;
  const hasJourney = trajectory != null && trajectory.waypoints.length > 0;

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
    setQuery(formatPlate(plate));
    setShowMatches(false);
    setMatches([]);
    setSyncedUrlPlate(plate);
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
  const anomalies = trajectory?.anomalies ?? [];
  const plateFlag = anomalies.length > 0 ? 'anomaly' : chip?.kind === 'watchlist' ? 'watchlist' : null;

  // ── map area states ──
  let mapArea: ReactNode;
  if (loading) {
    mapArea = <SkeletonPanel height="100%" className="h-full rounded-none" />;
  } else if (hasJourney) {
    mapArea = (
      <TrajectoryMap
        key={trajectory!.id}
        trajectory={trajectory!}
        activeIndex={activeIndex}
        onActiveIndexChange={setActiveIndex}
        focusRequest={focusRequest}
      />
    );
  } else if (current?.error) {
    mapArea = <ErrorState title="Could not reconstruct the journey" message={current.error} onRetry={() => setRetryNonce((n) => n + 1)} />;
  } else if (current) {
    mapArea = (
      <EmptyState
        icon={<NavigationIcon size={20} />}
        title={`No sightings for ${formatPlate(current.plate)}`}
        description="Check the plate or widen the time window."
      />
    );
  } else {
    mapArea = (
      <EmptyState
        icon={<SearchIcon size={20} />}
        title="Search a vehicle plate"
        description="Enter a licence plate above, or pick a suggested plate, to trace its journey across the camera network."
        action={<SuggestionChips suggestions={suggestions.slice(0, 6)} selectedPlate={null} onPick={selectPlate} className="justify-center" />}
      />
    );
  }

  return (
    <Page>
      <PageHeader
        title="Vehicle Trace"
        icon={RouteIcon}
        description="Reconstruct a vehicle's journey across the camera network"
        meta={(isSim || (!trajectory && suggestions.length > 0)) && <SimulationBadge />}
      />

      {/* Search */}
      <Panel>
        <form onSubmit={handleSubmit} className="flex flex-col gap-2 sm:flex-row" role="search">
          <div className="relative flex-1">
            <Input
              type="text"
              aria-label="Licence plate"
              placeholder="Enter plate — MH 01 CS 0126"
              icon={<SearchIcon size={16} strokeWidth={1.75} />}
              mono
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setShowMatches(true);
              }}
              onFocus={() => setShowMatches(true)}
              onBlur={() => setTimeout(() => setShowMatches(false), 150)}
              autoComplete="off"
              spellCheck={false}
              className="w-full [&_input]:h-9 [&_input]:text-[13px] [&_input]:uppercase [&_input::placeholder]:font-sans [&_input::placeholder]:normal-case"
            />
            {showMatches && visibleMatches.length > 0 && (
              <ul className="absolute left-0 right-0 top-full z-[1100] mt-1 max-h-80 overflow-y-auto rounded-md border border-line bg-surface py-1 shadow-pop" role="listbox" aria-label="Matching vehicles">
                {visibleMatches.map((v) => (
                  <li key={v.plate_text}>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => selectPlate(v.plate_text)}
                      className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left hover:bg-surface-2"
                    >
                      <PlateChip plate={v.plate_text} size="sm" variant={plateVariantOf(v)} />
                      <span className="text-xs tabular-nums text-fg-muted">
                        <span className="capitalize">{v.vehicle_type}</span> · {v.camera_count} camera{v.camera_count === 1 ? '' : 's'} · {v.detection_count} sightings
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <Button type="submit" variant="primary" icon={<RouteIcon size={16} strokeWidth={1.75} />}>
            Trace journey
          </Button>
        </form>
        {pickMessage && <p className="mt-2 text-xs text-fg-muted" role="status">{pickMessage}</p>}
        <SuggestionChips suggestions={suggestions} selectedPlate={selectedPlate} onPick={selectPlate} className="mt-3" />
      </Panel>

      {/* Anomalies */}
      {anomalies.length > 0 && (
        <div className="space-y-2">
          {anomalies.map((a) => (
            <div
              key={a.kind}
              role="alert"
              className="relative flex items-start gap-3 overflow-hidden rounded-md border border-danger/35 bg-danger/12 py-2.5 pl-4 pr-3"
            >
              <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-danger" />
              <TriangleAlertIcon size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-danger" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[13px] font-semibold text-danger">
                  {ANOMALY_TITLE[a.kind] ?? 'Anomaly'}
                  {a.kind === 'cloned_plate' ? <CopyIcon size={14} aria-hidden /> : a.kind === 'circling' ? <RepeatIcon size={14} aria-hidden /> : null}
                </div>
                <p className="mt-0.5 text-xs text-fg">{a.message}</p>
              </div>
              {a.waypoint_indices && a.waypoint_indices.length > 0 && (
                <Button size="sm" variant="ghost" icon={<MapPinIcon size={14} />} onClick={() => handleTimelineSelect(a.waypoint_indices![0])}>
                  Show on map
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
        {/* Map + totals */}
        <div className="min-w-0 space-y-4">
          <Panel flush className={MAP_HEIGHT} bodyClassName="relative h-full">
            {mapArea}
          </Panel>

          {hasJourney && (
            <KpiStrip>
              <KpiTile label="Road distance" icon={<RouteIcon size={16} strokeWidth={1.75} />} value={formatDistance(trajectory!.total_distance_m ?? null)} />
              <KpiTile label="Time moving" icon={<TimerIcon size={16} strokeWidth={1.75} />} value={formatDuration(trajectory!.moving_time_seconds ?? null)} />
              <KpiTile label="Avg speed" icon={<GaugeIcon size={16} strokeWidth={1.75} />} value={formatSpeed(avgSpeed)} />
              <KpiTile label="Cameras" icon={<CameraIcon size={16} strokeWidth={1.75} />} value={trajectory!.camera_count} hint={`${trajectory!.waypoints.length} sightings`} />
              <KpiTile
                label="Observed window"
                icon={<ClockIcon size={16} strokeWidth={1.75} />}
                value={`${formatIstHm(trajectory!.first_seen)}–${formatIstHm(trajectory!.last_seen)}`}
                hint={`${formatIstDate(trajectory!.first_seen)} · IST`}
              />
            </KpiStrip>
          )}
        </div>

        {/* Target + timeline */}
        <div className="flex min-w-0 flex-col gap-4">
          {hasJourney && (
            <Panel title="Target" id="vehicle-target">
              <PlateChip plate={trajectory!.plate_text} size="lg" variant={plateVariantOf(trajectory!)} flag={plateFlag} />
              <dl className="mt-3 divide-y divide-line">
                <DetailRow label="Class"><span className="capitalize">{trajectory!.vehicle_type}</span></DetailRow>
                {(chip?.kind === 'watchlist' || anomalies.length > 0) && (
                  <DetailRow label="Status">
                    <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
                      {chip?.kind === 'watchlist' && chip.priority && <SeverityChip severity={chip.priority} size="sm" label={`Watchlist · ${chip.label}`} />}
                      {anomalies.length > 0 && <Badge tone="danger" icon={<TriangleAlertIcon />}>Anomaly</Badge>}
                    </span>
                  </DetailRow>
                )}
                {chip?.reason && chip.kind === 'watchlist' && <DetailRow label="Reason"><span className="text-fg-muted">{chip.reason}</span></DetailRow>}
                <DetailRow label="First seen"><span className="font-mono tabular-nums">{formatIstTime(trajectory!.first_seen)} IST</span></DetailRow>
                <DetailRow label="Last seen"><span className="font-mono tabular-nums">{formatIstTime(trajectory!.last_seen)} IST</span></DetailRow>
                <DetailRow label="Data source">
                  {trajectory!.source === 'supabase' ? 'Live detections (Supabase)' : isSim ? <SimulationBadge compact /> : 'Sample data'}
                </DetailRow>
              </dl>
            </Panel>
          )}

          <Panel
            title="Journey timeline"
            subtitle={hasJourney ? `${trajectory!.waypoints.length} sightings` : undefined}
            icon={<ListOrderedIcon />}
            scroll
            className={cn(RAIL_MAX_H, 'min-h-[200px]')}
          >
            {loading ? (
              <div className="space-y-3" aria-busy="true">
                {Array.from({ length: 6 }, (_, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <Skeleton className="h-[22px] w-[22px] rounded-full" />
                    <Skeleton className="h-4 flex-1" />
                    <Skeleton className="h-4 w-16" />
                  </div>
                ))}
              </div>
            ) : hasJourney ? (
              <TrajectoryTimeline trajectory={trajectory!} activeIndex={activeIndex} onSelect={handleTimelineSelect} />
            ) : (
              <p className="py-8 text-center text-xs text-fg-muted">Select a vehicle plate to view its camera sightings.</p>
            )}
          </Panel>
        </div>
      </div>
    </Page>
  );
}

export default VehiclesPage;
