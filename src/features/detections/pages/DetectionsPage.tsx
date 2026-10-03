// ═══════════════════════════════════════════════════
// DetectionsPage — ANPR event log across all cameras.
// Filters live in the URL (?plate=&camera=&conf=) so other screens
// (Live Map popup, Cameras) can deep-link into a filtered log. No vehicle
// class column or filter: the model's class output is unreliable on the clips.
// ═══════════════════════════════════════════════════

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  CctvIcon, DownloadIcon, FilterXIcon, GaugeIcon, ListIcon, RefreshCwIcon, RouteIcon, ScanLineIcon,
  CarIcon, SearchIcon, TagIcon,
} from 'lucide-react';
import type { Detection } from '@/types';
import { useCameras } from '@/features/cameras/hooks/useCameras';
import { Page, PageHeader } from '@/shared/layout/Page';
import { Panel } from '@/shared/ui/Card';
import { Badge } from '@/shared/ui/Badge';
import { Button, IconButton } from '@/shared/ui/Button';
import { KpiTile } from '@/shared/ui/KpiTile';
import { Input, Select, Toolbar } from '@/shared/ui/Input';
import { DataTable, type Column } from '@/shared/ui/DataTable';
import { EmptyState } from '@/shared/ui/EmptyState';
import { ErrorState } from '@/shared/ui/ErrorState';
import { PlateChip } from '@/shared/ui/PlateChip';
import { useDetectionsLog } from '../hooks/useDetectionsLog';
import { DISPLAY_READ_MIN_CONFIDENCE } from '../api';
import {
  EMPTY_FILTERS, detectionStats, detectionsToCsv, filterDetections, filtersFromParams,
  filtersToParams, formatFrameTime, hasActiveFilters, plateKey, type DetectionFilters,
} from '../lib/log';
import { ConfidenceBar } from '../components/ConfidenceBar';
import { DetectionDrawer } from '../components/DetectionDrawer';

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
  const { rows, vehiclesDetected, watchlist, loading, error, refetch } = useDetectionsLog();
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
    { key: 'time', header: 'Frame time', width: '104px', mono: true, cell: (d) => formatFrameTime(d.timestamp), sortValue: (d) => Number(d.frame_timestamp_sec ?? d.timestamp) || 0 },
    {
      key: 'plate', header: 'Plate', width: '150px',
      cell: (d) => <PlateChip plate={d.plate_text_raw} size="xs" flag={watchlist.has(plateKey(d.plate_text_raw)) ? 'watchlist' : null} />,
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
        description={`Verified plate reads (OCR confidence ≥ ${Math.round(DISPLAY_READ_MIN_CONFIDENCE * 100)} %, valid Indian plate format) from the AI ANPR engine, one per vehicle`}
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

      {/* 4 tiles: own grid (KpiStrip is fixed at 5 columns on xl) */}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <KpiTile label="Events" value={stats.events.toLocaleString('en-IN')} icon={<ListIcon size={16} />} loading={loading} hint={active ? `of ${rows.length} total` : 'all cameras'} />
        <KpiTile label="Unique plates" value={stats.uniquePlates.toLocaleString('en-IN')} icon={<TagIcon size={16} />} loading={loading} />
        <KpiTile label="Mean confidence" value={pct(stats.meanConfidence)} unit={stats.meanConfidence == null ? undefined : '%'} icon={<GaugeIcon size={16} />} tone="success" loading={loading} />
        <KpiTile
          label="Vehicles detected"
          value={vehiclesDetected.toLocaleString('en-IN')}
          icon={<CarIcon size={16} />}
          loading={loading}
          hint={vehiclesDetected > 0 ? `${Math.round((rows.length / vehiclesDetected) * 100)}% with a verified plate read` : 'on the published clips'}
        />
      </div>

      <Panel flush>
        <div className="border-b border-line px-4 py-3">
          <Toolbar>
            <Input
              aria-label="Filter by plate"
              placeholder="Plate — e.g. MH 02 EG 9588"
              mono
              icon={<SearchIcon size={16} strokeWidth={1.75} />}
              value={plateInput}
              onChange={(e) => setPlateInput(e.target.value.toUpperCase())}
              className="w-full sm:w-64"
            />
            <Select aria-label="Camera" icon={<CctvIcon size={14} strokeWidth={1.75} />} value={filters.camera} onChange={(e) => update({ camera: e.target.value })}>
              <option value="">All cameras</option>
              {cameras.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
            </Select>
            <Select aria-label="Minimum confidence" icon={<GaugeIcon size={14} strokeWidth={1.75} />} value={filters.conf} onChange={(e) => update({ conf: e.target.value as DetectionFilters['conf'] })}>
              <option value="">Any confidence</option>
              <option value="90">Confidence ≥ 90%</option>
              <option value="75">Confidence ≥ 75%</option>
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
            renderCard={(d) => ({
              body: (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-3">
                    <PlateChip plate={d.plate_text_raw} size="xs" flag={watchlist.has(plateKey(d.plate_text_raw)) ? 'watchlist' : null} />
                    <ConfidenceBar value={d.confidence_score} />
                  </div>
                  <div className="flex min-w-0 items-center gap-2 text-xs text-fg-muted">
                    <span className="shrink-0 font-mono tabular-nums">{formatFrameTime(d.timestamp)}</span>
                    {cameraCode(d.camera_id) && <span className="shrink-0 font-mono font-medium">{cameraCode(d.camera_id)}</span>}
                    <span className="truncate">{cameraName(d.camera_id)}</span>
                  </div>
                </div>
              ),
              actions: <IconButton size="sm" label={`Trace route of ${d.plate_text_raw}`} icon={<RouteIcon size={16} strokeWidth={1.75} />} onClick={() => trace(d.plate_text_raw)} />,
            })}
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
