// ═══════════════════════════════════════════════════
// LiveMapPage — command view: network KPIs, camera map, operations rail.
// ?cam=CODE selects (and flies to) a camera, e.g. from Cameras "Open on map".
// ═══════════════════════════════════════════════════

import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CarIcon, CctvIcon, GaugeIcon, LocateFixedIcon, ScanLineIcon, SirenIcon, TagIcon, TargetIcon } from 'lucide-react';
import type { Camera } from '@/types/camera';
import { useCameras } from '@/features/cameras/hooks/useCameras';
import type { LiveFeedEntry } from '@/mocks/fixtures/mockLiveFeed';
import { useLiveReads } from '@/features/detections/hooks/useLiveReads';
import { useWatchlistIndex } from '@/features/detections/hooks/useWatchlistKeys';
import { plateKey } from '@/features/detections/lib/log';
import { DEFAULT_MAP_CENTER, SECTOR_LABEL } from '@/config/constants';
import { SimulationBadge } from '@/features/vehicles/components/SimulationBadge';
import { ReplayControls } from '@/features/replay/ReplayControls';
import { useReplayView } from '@/features/replay/engine';
import { formatReplayClock } from '@/features/replay/clock';
import { Page } from '@/shared/layout/Page';
import { Panel } from '@/shared/ui/Card';
import { KpiStrip, KpiTile } from '@/shared/ui/KpiTile';
import { Button, IconButton } from '@/shared/ui/Button';
import { MapLegend, MapPanel } from '@/shared/ui/MapLegend';
import { EmptyState } from '@/shared/ui/EmptyState';
import { ErrorState } from '@/shared/ui/ErrorState';
import { SkeletonPanel } from '@/shared/ui/Skeleton';
import { MapView } from '../components/MapView';
import { OperationsRail } from '../components/OperationsRail';
import { useLiveMapData } from '../hooks/useLiveMapData';
import { alertHotspots, topOpenAlerts } from '../lib/alerts';
import { istHour } from '../lib/time';

const nf = new Intl.NumberFormat('en-IN');

function LayerToggle({ label, pressed, onToggle, icon }: { label: string; pressed: boolean; onToggle: () => void; icon: React.ReactNode }) {
  return (
    <Button
      size="sm"
      variant={pressed ? 'secondary' : 'ghost'}
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      icon={icon}
      onClick={onToggle}
      className={pressed ? 'text-fg' : 'text-fg-subtle'}
    >
      <span className="hidden md:inline">{label}</span>
    </Button>
  );
}

export function LiveMapPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { cameras, loading, error, refetch } = useCameras();
  const { summary, alerts } = useLiveMapData();

  const [showCameras, setShowCameras] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [showHotspots, setShowHotspots] = useState(true);
  const [recenterNonce, setRecenterNonce] = useState(0);
  // Deep link (?cam=) flies to the camera on first render.
  const [focusNonce, setFocusNonce] = useState(() => (params.get('cam') ? 1 : 0));

  const selectedCode = params.get('cam');
  const selectCamera = (cam: Camera, fly = false) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('cam', cam.code);
        return next;
      },
      { replace: true },
    );
    if (fly) setFocusNonce((n) => n + 1);
  };

  const online = cameras.filter((c) => c.status === 'online').length;
  const total = cameras.length;
  const ratio = total ? online / total : 0;
  const openAlerts = useMemo(() => topOpenAlerts(alerts.data ?? [], Number.POSITIVE_INFINITY), [alerts.data]);
  const critical = openAlerts.filter((a) => a.priority === 'critical').length;
  const alertsSimulated = (alerts.data ?? []).some((a) => (a as { simulated?: boolean }).simulated);
  const hotspots = useMemo(() => (showHotspots ? alertHotspots(alerts.data ?? []) : []), [alerts.data, showHotspots]);
  const replay = useReplayView(12);
  // Real model reads on the camera clips, streaming on each camera's live clock.
  const { reads: liveReads, now } = useLiveReads(null, { limit: 40 });
  const watch = useWatchlistIndex();
  const realFeed = useMemo<LiveFeedEntry[]>(() => {
    const names = new Map(cameras.map((c) => [c.code, c.name]));
    return liveReads.map((r) => ({
      id: r.key,
      plate: r.event.plate_text!,
      cameraCode: r.camera_code,
      cameraName: names.get(r.camera_code) ?? r.camera_code,
      confidence: Math.round((r.event.plate_confidence ?? 0) * 100),
      secondsAgo: Math.max(0, Math.round((now - r.at) / 1000)),
      watchlist: watch.get(plateKey(r.event.plate_text!)) ?? null,
    }));
  }, [liveReads, now, cameras, watch]);
  const feed = replay.feed ?? realFeed;
  // Marker popups: each camera's latest read (replay clock during a replay).
  const plates = useMemo(() => {
    const byCode = new Map(cameras.map((c) => [c.code, c.id]));
    const out: Record<string, string | undefined> = {};
    for (const f of [...feed].reverse()) {
      const id = byCode.get(f.cameraCode);
      if (id) out[id] = f.plate;
    }
    return out;
  }, [feed, cameras]);
  const stats = summary.data?.stats;
  const simHint = summary.data?.simulated ? <SimulationBadge compact /> : undefined;
  const simValue = (v: number | undefined, fmt: (n: number) => string = (n) => nf.format(n)) =>
    summary.error ? '—' : v == null ? '—' : fmt(v);

  return (
    <Page fullBleed>
      <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(420px,1fr)] gap-3 lg:grid-cols-[minmax(0,1fr)_360px] lg:grid-rows-[auto_minmax(0,1fr)]">
        <KpiStrip className="lg:col-span-2">
          <KpiTile
            label="Cameras online"
            value={`${online}/${total}`}
            icon={<CctvIcon size={16} />}
            tone={total === 0 ? 'default' : ratio === 1 ? 'success' : ratio >= 0.5 ? 'warning' : 'danger'}
            hint={total > 0 && online < total ? `${total - online} offline` : 'All feeds nominal'}
            loading={loading}
            onClick={() => navigate('/cameras')}
          />
          <KpiTile
            label="Detections · last hour"
            value={replay.readsLastHour != null ? nf.format(replay.readsLastHour) : simValue(stats?.sightings_per_hour[istHour()])}
            icon={<ScanLineIcon size={16} />}
            tone="info"
            hint={replay.active ? `Replay · to ${formatReplayClock(replay.clock).slice(0, 5)} IST` : summary.error ? 'Summary unavailable' : simHint}
            loading={summary.loading && !replay.active}
          />
          <KpiTile
            label="Open alerts"
            value={alerts.error ? '—' : openAlerts.length}
            icon={<SirenIcon size={16} />}
            tone={critical > 0 ? 'danger' : openAlerts.length > 0 ? 'warning' : 'success'}
            hint={
              alerts.error ? 'Alerts unavailable' : alertsSimulated ? (
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="shrink-0">{critical} critical</span>
                  <SimulationBadge compact />
                </span>
              ) : `${critical} critical`
            }
            loading={alerts.loading}
            onClick={() => navigate('/alerts')}
          />
          <KpiTile
            label="Network avg speed"
            value={simValue(stats?.hop_speed_kmph.mean, (n) => n.toFixed(1))}
            unit={stats ? 'km/h' : undefined}
            icon={<GaugeIcon size={16} />}
            hint={summary.error ? 'Summary unavailable' : simHint}
            loading={summary.loading}
          />
          <KpiTile
            label="Vehicles tracked today"
            value={simValue(stats?.vehicles)}
            icon={<CarIcon size={16} />}
            hint={summary.error ? 'Summary unavailable' : simHint}
            loading={summary.loading}
          />
        </KpiStrip>

        <Panel flush className="min-h-[420px]" bodyClassName="relative">
          {loading ? (
            <SkeletonPanel height="100%" className="absolute inset-0 rounded-none border-0" />
          ) : error ? (
            <div className="flex h-full items-center justify-center">
              <ErrorState title="Camera network unavailable" message={error} onRetry={refetch} />
            </div>
          ) : (
            <div className="absolute inset-0">
              <MapView
                cameras={cameras}
                selectedCode={selectedCode}
                onSelect={(c) => selectCamera(c)}
                lastPlateByCamera={plates}
                showCameras={showCameras}
                showLabels={showLabels}
                hotspots={hotspots}
                recenterNonce={recenterNonce}
                focusNonce={focusNonce}
              />

              <MapPanel position="top-left" className="hidden px-3 py-2 xl:block">
                <p className="text-[13px] font-semibold text-fg">{SECTOR_LABEL}</p>
                <p className="font-mono text-2xs tabular-nums text-fg-muted">
                  {DEFAULT_MAP_CENTER[0].toFixed(4)}° N, {DEFAULT_MAP_CENTER[1].toFixed(4)}° E
                </p>
              </MapPanel>

              <MapPanel position="top-right" className="flex items-center gap-1 p-1">
                <div role="group" aria-label="Map layers" className="flex items-center gap-0.5">
                  <LayerToggle label="Cameras" pressed={showCameras} onToggle={() => setShowCameras((v) => !v)} icon={<CctvIcon size={14} strokeWidth={1.75} />} />
                  <LayerToggle label="Labels" pressed={showLabels} onToggle={() => setShowLabels((v) => !v)} icon={<TagIcon size={14} strokeWidth={1.75} />} />
                  <LayerToggle label="Alert hotspots" pressed={showHotspots} onToggle={() => setShowHotspots((v) => !v)} icon={<TargetIcon size={14} strokeWidth={1.75} />} />
                </div>
                <span className="mx-0.5 h-5 w-px bg-line" aria-hidden="true" />
                <IconButton size="sm" label="Recenter" icon={<LocateFixedIcon size={16} strokeWidth={1.75} />} onClick={() => setRecenterNonce((n) => n + 1)} />
              </MapPanel>

              <MapPanel position="bottom-center" className="w-max max-w-[calc(100%-24px)] border-0 bg-transparent shadow-none">
                <ReplayControls className="shadow-pop" />
              </MapPanel>

              <MapLegend
                title="Legend"
                position="bottom-left"
                items={[
                  { label: 'Online', color: 'var(--map-cam-online)', shape: 'dot' },
                  { label: 'Offline', color: 'var(--map-cam-offline)', shape: 'dot' },
                  { label: 'Maintenance', color: 'var(--map-cam-maint)', shape: 'dot' },
                  { label: 'Selected', color: 'var(--map-selected)', shape: 'ring' },
                  { label: 'Alert hotspot', color: 'var(--sev-critical)', shape: 'ring' },
                ]}
              />

              {cameras.length === 0 && (
                <MapPanel position="bottom-center" className="w-[320px] max-w-[calc(100%-24px)]">
                  <EmptyState compact icon={<CctvIcon size={20} />} title="No cameras registered — add one in Admin" />
                </MapPanel>
              )}
            </div>
          )}
        </Panel>

        <OperationsRail
          className="min-h-[420px] lg:min-h-0"
          feed={feed}
          replaying={replay.active}
          alerts={openAlerts.slice(0, 8)}
          alertCount={openAlerts.length}
          alertsLoading={alerts.loading}
          alertsError={alerts.error}
          onRetryAlerts={alerts.retry}
          cameras={cameras}
          selectedCode={selectedCode}
          onPickCamera={(c) => selectCamera(c, true)}
        />
      </div>
    </Page>
  );
}
