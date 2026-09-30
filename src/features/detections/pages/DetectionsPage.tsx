// ═══════════════════════════════════════════════════
// DetectionsPage — ANPR event log across all cameras.
// Filters live in the URL (?plate=&camera=&class=&conf=) so other screens
// (Live Map popup, Cameras) can deep-link into a filtered log.
// ═══════════════════════════════════════════════════

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  DownloadIcon, FilterXIcon, GaugeIcon, ListIcon, RefreshCwIcon, RouteIcon, ScanLineIcon,
  SearchIcon, TagIcon, TriangleAlertIcon,
} from 'lucide-react';
import type { Detection } from '@/types';
import { useCameras } from '@/features/cameras/hooks/useCameras';
import { Page, PageHeader } from '@/shared/layout/Page';
import { Panel } from '@/shared/ui/Card';
import { Badge } from '@/shared/ui/Badge';
import { Button, IconButton } from '@/shared/ui/Button';
import { KpiStrip, KpiTile } from '@/shared/ui/KpiTile';
import { Input, Select, Toolbar } from '@/shared/ui/Input';
import { DataTable, type Column } from '@/shared/ui/DataTable';
import { EmptyState } from '@/shared/ui/EmptyState';
import { ErrorState } from '@/shared/ui/ErrorState';
import { PlateChip } from '@/shared/ui/PlateChip';
import { vehicleClassToPlateVariant } from '@/shared/lib/plate';
import { useDetectionsLog } from '../hooks/useDetectionsLog';
import {
  EMPTY_FILTERS, LOW_CONFIDENCE, detectionStats, detectionsToCsv, filterDetections, filtersFromParams,
  filtersToParams, formatFrameTime, hasActiveFilters, plateKey, type DetectionFilters,
} from '../lib/log';
import { ConfidenceBar } from '../components/ConfidenceBar';
import { VehicleClass } from '../components/VehicleClass';
import { DetectionDrawer } from '../components/DetectionDrawer';

const CLASS_OPTIONS = [
  { value: '', label: 'All classes' },
  { value: 'car', label: 'Car' },
  { value: 'truck', label: 'Truck' },
  { value: 'bus', label: 'Bus' },
  { value: 'motorcycle', label: 'Motorcycle' },
];

function downloadCsv(csv: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `nero-detections-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function DetectionsPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => filtersFromParams(params), [params]);
  const { rows, watchlist, loading, error, refetch } = useDetectionsLog();
  const { cameras } = useCameras();
  const [selected, setSelected] = useState<Detection | null>(null);

  // Plate input is local for instant typing; pushed to the URL after 150 ms.
  const [plateInput, setPlateInput] = useState(filters.plate);
  const [lastUrlPlate, setLastUrlPlate] = useState(filters.plate);
  if (filters.plate !== lastUrlPlate) {
    setLastUrlPlate(filters.plate);
    setPlateInput(filters.plate);
  }

  const update = (patch: Partial<DetectionFilters>) =>
    setParams((prev) => filtersToParams({ ...filtersFromParams(prev), ...patch }, prev), { replace: true });

  useEffect(() => {
    if (plateInput === filters.plate) return;
    const t = setTimeout(() => update({ plate: plateInput }), 150);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plateInput]);

  const cameraById = useMemo(() => new Map(cameras.map((c) => [c.id, c])), [cameras]);
  const cameraName = (id: string) => cameraById.get(id)?.name ?? id;
  const cameraCode = (id: string) => cameraById.get(id)?.code ?? '';

  const filtered = useMemo(() => filterDetections(rows, filters), [rows, filters]);
  const stats = useMemo(() => detectionStats(filtered), [filtered]);
  const active = hasActiveFilters(filters);
  const clearFilters = () => {
    setPlateInput('');
    setParams((prev) => filtersToParams(EMPTY_FILTERS, prev), { replace: true });
  };
  const trace = (plate: string) => navigate(`/vehicles?plate=${encodeURIComponent(plateKey(plate))}`);

  const columns: Column<Detection>[] = [
    { key: 'time', header: 'Frame time', width: '104px', mono: true, cell: (d) => formatFrameTime(d.timestamp), sortValue: (d) => String(d.timestamp) },
    {
      key: 'plate', header: 'Plate', width: '150px',
      cell: (d) => <PlateChip plate={d.plate_text_raw} size="xs" variant={vehicleClassToPlateVariant(d.vehicle_type)} flag={watchlist.has(plateKey(d.plate_text_raw)) ? 'watchlist' : null} />,
      sortValue: (d) => plateKey(d.plate_text_raw),
    },
    {
      key: 'camera', header: 'Camera', hideBelow: 'md',
      cell: (d) => (
        <span className="flex min-w-0 items-center gap-2">
          {cameraCode(d.camera_id) && <span className="font-mono text-xs font-medium text-fg-muted">{cameraCode(d.camera_id)}</span>}
          <span className="truncate">{cameraName(d.camera_id)}</span>
        </span>
      ),
      sortValue: (d) => cameraName(d.camera_id),
    },
    { key: 'class', header: 'Class', width: '130px', cell: (d) => <VehicleClass type={d.vehicle_type} />, sortValue: (d) => d.vehicle_type },
    { key: 'conf', header: 'Confidence', width: '130px', cell: (d) => <ConfidenceBar value={d.confidence_score} />, sortValue: (d) => d.confidence_score },
    { key: 'event', header: 'Event ID', width: '110px', hideBelow: 'lg', cell: (d) => <span className="font-mono text-xs text-fg-subtle">{d.event_id}</span> },
    {
      key: 'actions', header: <span className="sr-only">Actions</span>, width: '52px', align: 'right',
      cell: (d) => (
        <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <IconButton size="sm" label={`Trace route of ${d.plate_text_raw}`} icon={<RouteIcon size={16} strokeWidth={1.75} />} onClick={() => trace(d.plate_text_raw)} />
        </span>
      ),
    },
  ];

  const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(1)}`);

  return (
    <Page>
      <PageHeader
        title="Detections"
        description="ANPR event log across all cameras"
        icon={ScanLineIcon}
        meta={<Badge tone="neutral" size="sm" className="tabular-nums">{`${rows.length} events`}</Badge>}
        actions={
          <>
            <Button icon={<DownloadIcon size={14} strokeWidth={1.75} />} disabled={filtered.length === 0} onClick={() => downloadCsv(detectionsToCsv(filtered, cameraName))}>
              Export CSV
            </Button>
            <IconButton label="Refresh" variant="secondary" icon={<RefreshCwIcon size={16} strokeWidth={1.75} />} onClick={refetch} />
          </>
        }
      />

      <KpiStrip className="xl:grid-cols-4">
        <KpiTile label="Events" value={stats.events.toLocaleString('en-IN')} icon={<ListIcon size={16} />} loading={loading} hint={active ? `of ${rows.length} total` : 'all cameras'} />
        <KpiTile label="Unique plates" value={stats.uniquePlates.toLocaleString('en-IN')} icon={<TagIcon size={16} />} loading={loading} />
        <KpiTile label="Mean confidence" value={pct(stats.meanConfidence)} unit={stats.meanConfidence == null ? undefined : '%'} icon={<GaugeIcon size={16} />} tone="success" loading={loading} />
        <KpiTile label="Low confidence" value={stats.lowConfidence} icon={<TriangleAlertIcon size={16} />} tone="warning" hint={`below ${LOW_CONFIDENCE * 100}%`} loading={loading} />
      </KpiStrip>

      <Panel flush>
        <div className="border-b border-line px-4 py-3">
          <Toolbar>
            <Input
              aria-label="Filter by plate"
              placeholder="Plate — e.g. DL 01 AB 1234"
              mono
              icon={<SearchIcon size={16} strokeWidth={1.75} />}
              value={plateInput}
              onChange={(e) => setPlateInput(e.target.value.toUpperCase())}
              className="w-full sm:w-64"
            />
            <Select aria-label="Vehicle class" label="Class" value={filters.vclass} onChange={(e) => update({ vclass: e.target.value })}>
              {CLASS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
            <Select aria-label="Camera" label="Camera" value={filters.camera} onChange={(e) => update({ camera: e.target.value })}>
              <option value="">All cameras</option>
              {cameras.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
            </Select>
            <Select aria-label="Minimum confidence" label="Confidence" value={filters.conf} onChange={(e) => update({ conf: e.target.value as DetectionFilters['conf'] })}>
              <option value="">All</option>
              <option value="90">≥ 90%</option>
              <option value="75">≥ 75%</option>
            </Select>
            {active && (
              <Button variant="ghost" icon={<FilterXIcon size={14} strokeWidth={1.75} />} onClick={clearFilters}>
                Clear filters
              </Button>
            )}
            <span className="ml-auto text-xs text-fg-muted tabular-nums">
              {filtered.length} of {rows.length} events
            </span>
          </Toolbar>
        </div>

        {error ? (
          <ErrorState message={error} onRetry={refetch} compact />
        ) : (
          <DataTable
            caption="ANPR detections"
            columns={columns}
            rows={filtered}
            rowKey={(d) => d.event_id}
            loading={loading}
            maxHeight="calc(100dvh - 300px)"
            pageSize={50}
            onRowClick={setSelected}
            selectedKey={selected?.event_id ?? null}
            rowTone={(d) => (watchlist.has(plateKey(d.plate_text_raw)) ? 'danger' : null)}
            empty={
              <EmptyState
                compact
                icon={<ListIcon size={20} />}
                title="No detections match these filters"
                description="Widen the confidence range or clear the plate search."
                action={active ? <Button variant="secondary" icon={<FilterXIcon size={14} />} onClick={clearFilters}>Clear filters</Button> : undefined}
              />
            }
          />
        )}
      </Panel>

      <DetectionDrawer
        detection={selected}
        camera={selected ? cameraById.get(selected.camera_id) ?? null : null}
        onWatchlist={selected ? watchlist.has(plateKey(selected.plate_text_raw)) : false}
        onClose={() => setSelected(null)}
      />
    </Page>
  );
}
