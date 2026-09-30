// ═══════════════════════════════════════════════════
// AnalyticsPage — city traffic intelligence from the ANPR journey log
// Hourly volume, camera load, congestion heatmap + route density, speed
// distribution, zone OD matrix, corridors and bottlenecks. Every panel is
// re-scoped by the time-window selector.
// ═══════════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ArrowLeftRightIcon,
  ArrowRightIcon,
  CarIcon,
  ChartColumnIcon,
  ClockIcon,
  FlameIcon,
  GaugeIcon,
  LayersIcon,
  MapIcon,
  RouteIcon,
  SplitIcon,
  TrendingUpIcon,
} from 'lucide-react';
import { Page, PageHeader } from '@/shared/layout/Page';
import { Panel } from '@/shared/ui/Card';
import { KpiStrip, KpiTile } from '@/shared/ui/KpiTile';
import { Select } from '@/shared/ui/Input';
import { TabPanel, Tabs } from '@/shared/ui/Tabs';
import { DataTable, type Column } from '@/shared/ui/DataTable';
import { SeverityChip } from '@/shared/ui/SeverityChip';
import { SkeletonPanel } from '@/shared/ui/Skeleton';
import { ErrorState } from '@/shared/ui/ErrorState';
import { EmptyState } from '@/shared/ui/EmptyState';
import { SimulationBadge } from '@/features/vehicles/components/SimulationBadge';
import { loadRoadRoutes } from '@/features/vehicles/sim';
import type { RoadRoutesDoc } from '@/features/vehicles/lib/trajectory';
import { formatDuration } from '@/features/vehicles/lib/geo';
import { fetchNetworkAnalytics } from '../api';
import { TIME_WINDOWS, getWindow, istHour, type CameraLoad, type Corridor, type Flow, type NetworkAnalytics, type TimeWindowId, type ZoneStat } from '../lib/aggregate';
import { BarChart } from '../components/charts/BarChart';
import { LineChart } from '../components/charts/LineChart';
import { MatrixHeat } from '../components/charts/MatrixHeat';
import { SpeedDistribution } from '../components/charts/SpeedDistribution';
import { fmtInt } from '../components/charts/chartUtils';
import { CongestionMap } from '../components/CongestionMap';

type TabId = 'overview' | 'congestion' | 'od' | 'corridors' | 'speed';
const TABS: { id: TabId; label: string; icon: ReactNode }[] = [
  { id: 'overview', label: 'Overview', icon: <ChartColumnIcon size={16} strokeWidth={1.75} /> },
  { id: 'congestion', label: 'Congestion', icon: <FlameIcon size={16} strokeWidth={1.75} /> },
  { id: 'od', label: 'Origin–Destination', icon: <SplitIcon size={16} strokeWidth={1.75} /> },
  { id: 'corridors', label: 'Corridors', icon: <RouteIcon size={16} strokeWidth={1.75} /> },
  { id: 'speed', label: 'Speed', icon: <GaugeIcon size={16} strokeWidth={1.75} /> },
];

const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--series-6)'];
const HOURS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);
const hourRange = (h: number) => `${HOURS[h]}–${HOURS[(h + 1) % 24]}`;

function useAnalytics(windowId: TimeWindowId) {
  const [state, setState] = useState<{ id: string; data: NetworkAnalytics | null; error: string | null } | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    fetchNetworkAnalytics(windowId)
      .then((data) => alive && setState({ id: `${windowId}:${nonce}`, data, error: null }))
      .catch((e) => alive && setState({ id: `${windowId}:${nonce}`, data: null, error: e instanceof Error ? e.message : 'Failed to load analytics' }));
    return () => {
      alive = false;
    };
  }, [windowId, nonce]);
  const current = state?.id === `${windowId}:${nonce}` ? state : null;
  return {
    // Keep showing the previous window while the next one computes (no flash).
    data: current?.data ?? state?.data ?? null,
    error: current?.error ?? null,
    loading: current == null,
    retry: useCallback(() => setNonce((n) => n + 1), []),
  };
}

function useRoadRoutes() {
  const [routes, setRoutes] = useState<RoadRoutesDoc | null>(null);
  useEffect(() => {
    let alive = true;
    loadRoadRoutes().then((r) => alive && setRoutes(r)).catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return routes;
}

/** Panel body that owns its loading / error / empty states. */
function ChartBody({ data, error, onRetry, height = 240, empty, children }: {
  data: unknown;
  error: string | null;
  onRetry: () => void;
  height?: number;
  empty?: boolean;
  children: () => ReactNode;
}) {
  if (error) return <ErrorState compact message={error} onRetry={onRetry} />;
  if (!data) return <SkeletonPanel height={height} />;
  if (empty) return <EmptyState compact title="No traffic in this window" description="Choose a wider time window." />;
  return <>{children()}</>;
}

const LEVEL_LABEL = { high: 'Heavy', medium: 'Moderate', low: 'Free flow' } as const;

export function AnalyticsPage() {
  const [params, setParams] = useSearchParams();
  const windowId = getWindow(params.get('window') ?? 'all').id;
  const tab = (TABS.find((t) => t.id === params.get('tab'))?.id ?? 'overview') as TabId;
  const setParam = (k: string, v: string, dflt: string) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (v === dflt) n.delete(k);
      else n.set(k, v);
      return n;
    }, { replace: true });

  const { data, error, loading, retry } = useAnalytics(windowId);
  const routes = useRoadRoutes();
  const win = getWindow(windowId);
  const nowHour = istHour(new Date().toISOString());
  const windowHours = useMemo(() => new Set(win.hours), [win]);
  const empty = data != null && data.totals.sightings === 0;
  const body = (children: () => ReactNode, height?: number) => (
    <ChartBody data={data} error={error} onRetry={retry} height={height} empty={empty}>
      {children}
    </ChartBody>
  );

  const zoneCols: Column<ZoneStat>[] = [
    { key: 'zone', header: 'Zone', cell: (z) => <span className="font-medium text-fg">{z.zone}</span>, sortValue: (z) => z.zone },
    { key: 'level', header: 'Level', cell: (z) => <SeverityChip severity={z.level} size="sm" label={LEVEL_LABEL[z.level]} />, sortValue: (z) => ({ high: 0, medium: 1, low: 2 })[z.level] },
    { key: 'cams', header: 'Cameras', align: 'right', mono: true, cell: (z) => z.cameras, hideBelow: 'sm' },
    { key: 'vol', header: 'Sightings', align: 'right', mono: true, cell: (z) => fmtInt(z.sightings), sortValue: (z) => z.sightings },
    { key: 'spd', header: 'Avg speed', align: 'right', mono: true, cell: (z) => (z.avgSpeed == null ? '—' : `${z.avgSpeed} km/h`), sortValue: (z) => z.avgSpeed ?? 0 },
  ];

  const camCols: Column<CameraLoad & { rank: number }>[] = [
    { key: 'rank', header: '#', width: '40px', mono: true, cell: (c) => c.rank },
    {
      key: 'cam', header: 'Camera',
      cell: (c) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium text-fg">{c.name}</span>
          <span className="font-mono text-2xs text-fg-subtle">{c.code} · {c.zone}</span>
        </span>
      ),
    },
    { key: 'level', header: 'Level', cell: (c) => <SeverityChip severity={c.level} size="sm" label={LEVEL_LABEL[c.level]} /> },
    { key: 'vol', header: 'Sightings', align: 'right', mono: true, cell: (c) => fmtInt(c.sightings), sortValue: (c) => c.sightings },
    { key: 'spd', header: 'Avg approach', align: 'right', mono: true, cell: (c) => (c.avgSpeed == null ? '—' : `${c.avgSpeed} km/h`), sortValue: (c) => c.avgSpeed ?? 0, hideBelow: 'sm' },
    {
      key: 'score', header: 'Bottleneck index', align: 'right', sortValue: (c) => c.bottleneckScore,
      cell: (c) => (
        <span className="inline-flex items-center justify-end gap-2">
          <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-surface-3 md:inline-block" aria-hidden>
            <span className="block h-full rounded-full bg-sev-high" style={{ width: `${Math.min(100, c.bottleneckScore)}%` }} />
          </span>
          <span className="font-mono tabular-nums">{c.bottleneckScore}</span>
        </span>
      ),
    },
  ];

  const flowCols: Column<Flow>[] = [
    {
      key: 'flow', header: 'Flow',
      cell: (f) => (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <span className="truncate text-fg">{f.from.name}</span>
          <ArrowRightIcon size={14} className="shrink-0 text-fg-subtle" aria-label="to" />
          <span className="truncate text-fg">{f.to.name}</span>
        </span>
      ),
    },
    { key: 'codes', header: 'Cameras', mono: true, hideBelow: 'md', cell: (f) => `${f.from.code} / ${f.to.code}` },
    { key: 'n', header: 'Journeys', align: 'right', mono: true, cell: (f) => fmtInt(f.count), sortValue: (f) => f.count },
    { key: 't', header: 'Avg time', align: 'right', mono: true, cell: (f) => formatDuration(f.avgTimeS), sortValue: (f) => f.avgTimeS ?? 0 },
  ];

  const corridorCols: Column<Corridor>[] = [
    {
      key: 'name', header: 'Corridor', sortValue: (c) => c.from.name,
      cell: (c) => (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium text-fg">{c.from.name}</span>
          <ArrowLeftRightIcon size={14} className="shrink-0 text-fg-subtle" aria-label="and" />
          <span className="truncate font-medium text-fg">{c.to.name}</span>
        </span>
      ),
    },
    { key: 'trips', header: 'Trips', align: 'right', mono: true, cell: (c) => fmtInt(c.trips), sortValue: (c) => c.trips },
    { key: 'time', header: 'Avg travel time', align: 'right', mono: true, cell: (c) => formatDuration(c.avgTimeS), sortValue: (c) => c.avgTimeS },
    { key: 'speed', header: 'Avg speed', align: 'right', mono: true, hideBelow: 'md', cell: (c) => `${c.avgSpeed} km/h`, sortValue: (c) => c.avgSpeed },
    { key: 'dist', header: 'Road km', align: 'right', mono: true, hideBelow: 'lg', cell: (c) => (c.avgDistanceM / 1000).toFixed(1), sortValue: (c) => c.avgDistanceM },
    { key: 'peak', header: 'Peak window', mono: true, hideBelow: 'sm', cell: (c) => hourRange(c.peakHour), sortValue: (c) => c.peakHour },
    { key: 'pc', header: 'Peak trips', align: 'right', mono: true, cell: (c) => c.peakCount, sortValue: (c) => c.peakCount },
  ];

  const t = data?.totals;

  const hourlyChart = () => (
    <BarChart
      ariaLabel="Sightings per hour of day (IST)"
      valueLabel="Sightings"
      data={data!.hourly.map((v, h) => ({ key: String(h), label: HOURS[h].slice(0, 2), value: v, sub: `${hourRange(h)} IST` }))}
      muted={(d) => !windowHours.has(Number(d.key))}
      marker={{ key: String(nowHour), label: 'Now' }}
      labelEvery={3}
      height={220}
    />
  );
  const cameraChart = () => (
    <BarChart
      orientation="horizontal"
      ariaLabel="Sightings per camera"
      valueLabel="Sightings"
      data={data!.cameras.map((c) => ({
        key: c.code,
        label: c.name,
        value: c.sightings,
        sub: `${c.code} · ${c.zone}`,
        extra: [{ label: 'Avg approach', value: c.avgSpeed == null ? '—' : `${c.avgSpeed} km/h` }],
      }))}
    />
  );
  const heatmap = () => (
    <div className="h-[340px]">
      <CongestionMap cameras={data!.cameras} corridors={data!.corridors} routes={routes} />
    </div>
  );
  const speedChart = () => (data!.speed ? <SpeedDistribution stats={data!.speed} /> : <EmptyState compact title="No speed samples" />);
  const zoneSpeedChart = () => (
    <BarChart
      orientation="horizontal"
      ariaLabel="Average speed per zone"
      valueLabel="Avg speed (km/h)"
      format={(n) => `${Math.round(n)} km/h`}
      color="var(--series-2)"
      labelWidth={130}
      data={data!.zones.map((z) => ({ key: z.zone, label: z.zone, value: z.avgSpeed ?? 0, extra: [{ label: 'Sightings', value: fmtInt(z.sightings) }] }))}
    />
  );
  const trends = () => (
    <LineChart
      ariaLabel="Hourly sightings per zone (IST)"
      valueLabel="Sightings"
      xLabels={HOURS}
      band={[...windowHours]}
      series={data!.hourlyByZone.map((z, i) => ({ name: z.zone, values: z.values, color: SERIES[i % SERIES.length] }))}
    />
  );

  return (
    <Page>
      <PageHeader
        title="Traffic Analytics"
        icon={ChartColumnIcon}
        description="City-wide flow, congestion and movement patterns aggregated from multi-camera ANPR journeys"
        meta={<SimulationBadge />}
        actions={
          <Select
            label="Window"
            icon={<ClockIcon strokeWidth={1.75} />}
            value={windowId}
            onChange={(e) => setParam('window', e.target.value, 'all')}
            aria-label="Time window"
          >
            {TIME_WINDOWS.map((w) => (
              <option key={w.id} value={w.id}>{w.label}</option>
            ))}
          </Select>
        }
      />

      <KpiStrip>
        <KpiTile label="Vehicles observed" icon={<CarIcon size={16} strokeWidth={1.75} />} loading={!t} value={t ? fmtInt(t.vehicles) : '—'} hint={win.id === 'all' ? '29 Sep 2026 · IST' : win.label} />
        <KpiTile label="Journeys" icon={<RouteIcon size={16} strokeWidth={1.75} />} loading={!t} value={t ? fmtInt(t.journeys) : '—'} hint={t ? `${fmtInt(t.sightings)} camera sightings` : undefined} />
        <KpiTile label="Multi-camera" icon={<LayersIcon size={16} strokeWidth={1.75} />} tone="info" loading={!t} value={t ? t.multiCameraPct.toFixed(1) : '—'} unit="%" hint={t ? `${fmtInt(t.multiCameraJourneys)} journeys seen by 2+ cameras` : undefined} />
        <KpiTile label="Mean hop speed" icon={<GaugeIcon size={16} strokeWidth={1.75} />} tone={t?.meanHopSpeed != null && t.meanHopSpeed < 20 ? 'warning' : 'default'} loading={!t} value={t?.meanHopSpeed ?? '—'} unit="km/h" hint={data?.speed ? `P10 ${data.speed.p10} · P90 ${data.speed.p90}` : undefined} />
        <KpiTile label="Road distance" icon={<MapIcon size={16} strokeWidth={1.75} />} loading={!t} value={t ? fmtInt(t.totalKm) : '—'} unit="km" hint="Between consecutive sightings" />
      </KpiStrip>

      <div>
        <Tabs items={TABS} value={tab} onChange={(id) => setParam('tab', id, 'overview')} ariaLabel="Analytics views" />
        {loading && data && <span className="sr-only" role="status">Updating for {win.label}</span>}

        <TabPanel id="overview" active={tab === 'overview'} className="mt-4 space-y-4">
          <div className="grid gap-4 xl:grid-cols-2">
            <Panel title="Hourly volume" subtitle="Sightings per hour · IST" icon={<ChartColumnIcon />}>{body(hourlyChart, 220)}</Panel>
            <Panel title="Camera load" subtitle={win.label} icon={<LayersIcon />}>{body(cameraChart, 234)}</Panel>
            <Panel title="Congestion heatmap" subtitle="Camera load and route density" icon={<FlameIcon />} flush>
              {body(heatmap, 340)}
            </Panel>
            <Panel title="Speed distribution" subtitle="Hop speeds between cameras" icon={<GaugeIcon />}>{body(speedChart, 260)}</Panel>
          </div>
          <Panel title="Flow trends by zone" subtitle="Hourly sightings · selected window shaded" icon={<TrendingUpIcon />}>{body(trends, 260)}</Panel>
        </TabPanel>

        <TabPanel id="congestion" active={tab === 'congestion'} className="mt-4 space-y-4">
          <Panel title="Congestion bottlenecks" subtitle="Cameras ranked by volume × slowdown vs network mean" icon={<FlameIcon />} flush>
            {body(() => (
              <DataTable
                caption="Congestion bottlenecks by camera"
                columns={camCols}
                rows={[...data!.cameras].sort((a, b) => b.bottleneckScore - a.bottleneckScore).map((c, i) => ({ ...c, rank: i + 1 }))}
                rowKey={(c) => c.code}
                rowTone={(c) => (c.level === 'high' ? 'warning' : null)}
              />
            ))}
          </Panel>
          <div className="grid gap-4 xl:grid-cols-2">
            <Panel title="Zones" subtitle={win.label} flush>
              {body(() => <DataTable caption="Congestion by zone" columns={zoneCols} rows={data!.zones} rowKey={(z) => z.zone} />)}
            </Panel>
            <Panel title="Zone volume" subtitle="Sightings per zone">
              {body(() => (
                <BarChart
                  orientation="horizontal"
                  ariaLabel="Sightings per zone"
                  valueLabel="Sightings"
                  labelWidth={130}
                  data={data!.zones.map((z) => ({ key: z.zone, label: z.zone, value: z.sightings, extra: [{ label: 'Level', value: LEVEL_LABEL[z.level] }] }))}
                  colorFor={(d) => {
                    const lvl = data!.zones.find((z) => z.zone === d.key)?.level;
                    return lvl === 'high' ? 'var(--sev-high)' : lvl === 'medium' ? 'var(--sev-medium)' : 'var(--series-2)';
                  }}
                />
              ))}
            </Panel>
          </div>
        </TabPanel>

        <TabPanel id="od" active={tab === 'od'} className="mt-4 space-y-4">
          <Panel title="Origin–destination matrix" subtitle="Journeys by first and last camera zone" icon={<SplitIcon />}>
            {body(() => (
              <MatrixHeat
                ariaLabel="Journeys between zones"
                rowTitle="Origin"
                colTitle="Destination"
                valueLabel="Journeys"
                rows={data!.od.zones}
                cols={data!.od.zones}
                cells={data!.od.cells.map((r) => r.map((c) => ({ count: c.count, extra: [{ label: 'Avg time', value: formatDuration(c.avgTimeS) }] })))}
              />
            ), 280)}
          </Panel>
          <Panel title="Top flows" subtitle="Camera to camera, first to last sighting" flush>
            {body(() => (
              <DataTable caption="Top origin–destination flows" columns={flowCols} rows={data!.topFlows} rowKey={(f) => `${f.from.code}>${f.to.code}`} empty={<EmptyState compact title="No multi-camera journeys" />} />
            ))}
          </Panel>
        </TabPanel>

        <TabPanel id="corridors" active={tab === 'corridors'} className="mt-4 space-y-4">
          <Panel title="Corridors" subtitle="Consecutive camera pairs, both directions" icon={<RouteIcon />} flush>
            {body(() => (
              <DataTable caption="Corridor statistics" columns={corridorCols} rows={data!.corridors} rowKey={(c) => c.id} pageSize={12} initialSort={{ key: 'trips', dir: 'desc' }} />
            ))}
          </Panel>
          <Panel title="Travel time comparison" subtitle="Average travel time, 10 busiest corridors">
            {body(() => (
              <BarChart
                orientation="horizontal"
                ariaLabel="Average travel time per corridor"
                valueLabel="Avg travel time"
                format={(s) => formatDuration(s)}
                color="var(--series-3)"
                labelWidth={200}
                data={data!.corridors.slice(0, 10).map((c) => ({
                  key: c.id,
                  label: `${c.from.code} – ${c.to.code}`,
                  sub: `${c.from.name} – ${c.to.name}`,
                  value: c.avgTimeS,
                  extra: [{ label: 'Trips', value: fmtInt(c.trips) }, { label: 'Avg speed', value: `${c.avgSpeed} km/h` }],
                }))}
              />
            ))}
          </Panel>
        </TabPanel>

        <TabPanel id="speed" active={tab === 'speed'} className="mt-4">
          <div className="grid gap-4 xl:grid-cols-2">
            <Panel title="Speed distribution" subtitle="Hop speeds · 5 km/h bins, P10–P90 highlighted" icon={<GaugeIcon />}>{body(speedChart, 260)}</Panel>
            <Panel title="Average speed by zone" subtitle="Hops arriving in each zone">{body(zoneSpeedChart, 200)}</Panel>
          </div>
        </TabPanel>
      </div>
    </Page>
  );
}

export default AnalyticsPage;
