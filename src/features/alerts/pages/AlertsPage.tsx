// ═══════════════════════════════════════════════════
// AlertsPage — real-time triage queue
// Watchlist hits and suspicious-route anomalies, sorted by severity; a detail
// panel with location, watchlist entry and the plate's recent sightings.
// ═══════════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  CheckIcon,
  CircleCheckIcon,
  CopyIcon,
  OctagonAlertIcon,
  RefreshCwIcon,
  RepeatIcon,
  RouteIcon,
  ShieldAlertIcon,
  SirenIcon,
  TimerIcon,
  TriangleAlertIcon,
  UserRoundCheckIcon,
} from 'lucide-react';
import type { AlertRecord, BlacklistEntry, Trajectory } from '@/types';
import { fetchAlerts, acknowledgeAlert, fetchBlacklistEntries } from '@/features/alerts/api';
import { fetchTrajectoryByPlate } from '@/features/vehicles/api';
import { buildCameraIndex } from '@/features/vehicles/sim';
import { formatDuration, formatIstDate, formatIstTime, normalizePlate } from '@/features/vehicles/lib/geo';
import { usePrefersReducedMotion } from '@/features/vehicles/hooks/usePrefersReducedMotion';
import { SimulationBadge } from '@/features/vehicles/components/SimulationBadge';
import { Page, PageHeader } from '@/shared/layout/Page';
import { Panel } from '@/shared/ui/Card';
import { Badge } from '@/shared/ui/Badge';
import { Button, IconButton } from '@/shared/ui/Button';
import { KpiStrip, KpiTile } from '@/shared/ui/KpiTile';
import { Select, Toolbar } from '@/shared/ui/Input';
import { PlateChip } from '@/shared/ui/PlateChip';
import { SeverityChip } from '@/shared/ui/SeverityChip';
import { Skeleton, SkeletonPanel } from '@/shared/ui/Skeleton';
import { Timeline, TimelineItem } from '@/shared/ui/Timeline';
import { EmptyState } from '@/shared/ui/EmptyState';
import { ErrorState } from '@/shared/ui/ErrorState';
import { toast } from '@/shared/ui/toast';
import { cn } from '@/shared/lib/cn';
import { useAuth } from '@/features/auth/session';
import { useOperatorAction } from '@/features/auth/guard';
import { ReplayControls } from '@/features/replay/ReplayControls';
import { subscribeReplay } from '@/features/replay/clock';
import { applyAlertEvent, subscribeAlertEvents } from '../live';
import { ALERT_KIND_LABEL, alertKind, type TriageAlert } from '../types';
import { medianAckSeconds, newAlertIds, relativeTime, sortForTriage } from '../lib/triage';
import { AlertMiniMap, type MiniMapPoint } from '../components/AlertMiniMap';

/** Fallback poll; new alerts normally arrive via the 10 s live poll / replay events. */
const POLL_MS = 30_000;

const SEV_BAR: Record<AlertRecord['priority'], string> = {
  critical: 'bg-sev-critical',
  high: 'bg-sev-high',
  medium: 'bg-sev-medium',
  low: 'bg-sev-low',
};

const CAMERAS = buildCameraIndex(null);
const cameraCodeOf = (a: TriageAlert) => a.camera_code ?? [...CAMERAS.values()].find((c) => c.id === a.camera_id)?.code;

function KindBadge({ alert }: { alert: TriageAlert }) {
  const kind = alertKind(alert);
  if (kind === 'watchlist') return <Badge tone="neutral" className="uppercase tracking-[0.04em]">{alert.category}</Badge>;
  return (
    <Badge tone="danger" icon={kind === 'cloned_plate' ? <CopyIcon strokeWidth={1.75} /> : <RepeatIcon strokeWidth={1.75} />}>
      {ALERT_KIND_LABEL[kind]}
    </Badge>
  );
}

const plateFlag = (a: TriageAlert) => (alertKind(a) === 'watchlist' ? 'watchlist' : 'anomaly');
const routeUrl = (plate: string) => `/vehicles?plate=${encodeURIComponent(plate)}`;

function AlertTime({ iso, className }: { iso: string; className?: string }) {
  return (
    <time dateTime={iso} title={`${formatIstDate(iso)} · ${relativeTime(iso)}`} className={cn('font-mono tabular-nums', className)}>
      {formatIstTime(iso)} IST
    </time>
  );
}

// ── detail panel ─────────────────────────────────

function useRecentSightings(plate: string | null) {
  const [state, setState] = useState<{ plate: string; t: Trajectory | null } | null>(null);
  useEffect(() => {
    if (!plate) return;
    let alive = true;
    fetchTrajectoryByPlate(plate)
      .then((t) => alive && setState({ plate, t }))
      .catch(() => alive && setState({ plate, t: null }));
    return () => {
      alive = false;
    };
  }, [plate]);
  return state?.plate === plate ? { loading: false, trajectory: state.t } : { loading: plate != null, trajectory: null };
}

function AlertDetail({ alert, entry, onAcknowledge }: { alert: TriageAlert; entry: BlacklistEntry | null; onAcknowledge: (a: TriageAlert) => void }) {
  const navigate = useNavigate();
  const kind = alertKind(alert);
  const { loading, trajectory } = useRecentSightings(alert.plate_text);
  const cutoff = Date.parse(alert.timestamp);
  const recent = (trajectory?.waypoints ?? []).filter((w) => Date.parse(w.timestamp) <= cutoff).slice(-5);

  const points: MiniMapPoint[] = alert.evidence?.length
    ? alert.evidence.flatMap((e) => {
        const c = CAMERAS.get(e.camera_code);
        return c ? [{ lat: c.lat, lng: c.lng, label: `${c.code} ${formatIstTime(e.timestamp)}`, primary: e.camera_code === alert.camera_code }] : [];
      })
    : [{ lat: alert.lat, lng: alert.lng, label: cameraCodeOf(alert) ?? alert.camera_name, primary: true }];

  const rows: [string, React.ReactNode][] = [
    ['Type', ALERT_KIND_LABEL[kind]],
    ['Camera', <span key="c"><span className="font-mono text-fg-muted">{cameraCodeOf(alert)}</span> {alert.camera_name}</span>],
    ['Detected', <span key="d"><AlertTime iso={alert.timestamp} /> <span className="text-fg-subtle">· {formatIstDate(alert.timestamp)}</span></span>],
  ];
  if (kind === 'watchlist') {
    rows.push(['Category', <span key="cat" className="capitalize">{entry?.category ?? alert.category}</span>]);
    if (entry) rows.push(['Listed since', formatIstDate(entry.valid_from)]);
  }
  if (alert.acknowledged) {
    rows.push(['Acknowledged', `${alert.acknowledged_by ?? 'Operator'}${alert.acknowledged_at ? ` · ${formatIstTime(alert.acknowledged_at)}` : ''}`]);
  }

  return (
    <div className="space-y-4">
      <div className="h-[200px] overflow-hidden rounded-md border border-line">
        <AlertMiniMap points={points} link={kind !== 'watchlist'} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <PlateChip plate={alert.plate_text} size="lg" flag={plateFlag(alert)} />
        <SeverityChip severity={alert.priority} size="md" />
        <KindBadge alert={alert} />
      </div>
      <p className="text-[13px] font-medium text-fg">{alert.reason}</p>
      <dl className="divide-y divide-line rounded-md border border-line text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-3 px-3 py-1.5">
            <dt className="text-fg-muted">{k}</dt>
            <dd className="text-right text-fg">{v}</dd>
          </div>
        ))}
      </dl>

      {alert.evidence && alert.evidence.length > 0 && (
        <section aria-label="Evidence">
          <h3 className="mb-1 text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">Evidence</h3>
          <Timeline ariaLabel="Evidence sightings">
            {alert.evidence.map((e, i) => (
              <TimelineItem
                key={`${e.camera_code}-${e.timestamp}`}
                marker={{ label: String(i + 1), color: 'var(--danger)' }}
                title={CAMERAS.get(e.camera_code)?.name ?? e.camera_code}
                meta={<span className="font-mono">{e.camera_code}</span>}
                time={formatIstTime(e.timestamp)}
                last={i === alert.evidence!.length - 1}
              />
            ))}
          </Timeline>
        </section>
      )}

      {kind === 'watchlist' && (
        <section aria-label="Recent sightings">
          <h3 className="mb-1 text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">Last sightings up to this alert</h3>
          {loading ? (
            <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-9" />)}</div>
          ) : recent.length === 0 ? (
            <p className="py-2 text-xs text-fg-muted">No other sightings on record.</p>
          ) : (
            <Timeline ariaLabel="Recent sightings of this plate">
              {recent.map((w, i) => (
                <TimelineItem
                  key={`${w.camera_id}-${w.timestamp}`}
                  marker={{ label: String(trajectory!.waypoints.indexOf(w) + 1) }}
                  title={w.camera_name}
                  meta={<span className="font-mono">{w.camera_code}</span>}
                  time={formatIstTime(w.timestamp)}
                  last={i === recent.length - 1}
                />
              ))}
            </Timeline>
          )}
        </section>
      )}

      <div className="flex flex-wrap gap-2 border-t border-line pt-3">
        {!alert.acknowledged && (
          <Button variant="success" icon={<CheckIcon size={14} />} onClick={() => onAcknowledge(alert)}>
            Acknowledge
          </Button>
        )}
        <Button variant="primary" icon={<RouteIcon size={14} />} onClick={() => navigate(routeUrl(alert.plate_text))}>
          View full route
        </Button>
        <Button disabled title="Demo build" icon={<SirenIcon size={14} />}>
          Escalate
        </Button>
      </div>
    </div>
  );
}

// ── page ─────────────────────────────────────────

export function AlertsPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const reduced = usePrefersReducedMotion();
  const { user } = useAuth();
  const guard = useOperatorAction();
  const operator = user?.name ?? 'Operator';
  const operatorRef = useRef(operator);
  useEffect(() => {
    operatorRef.current = operator;
  }, [operator]);
  const [alerts, setAlerts] = useState<TriageAlert[]>([]);
  const [entries, setEntries] = useState<BlacklistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('unack');
  const [cameraFilter, setCameraFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [selectedId, setSelectedId] = useState<string | null>(() => params.get('id'));
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const alertsRef = useRef<TriageAlert[]>([]);
  const pendingAcks = useRef(new Set<string>());

  const apply = useCallback((data: TriageAlert[], announce: boolean) => {
    // Keep optimistic acknowledgements that the server has not reflected yet.
    const merged = data.map((a) => (pendingAcks.current.has(a.id) && !a.acknowledged
      ? { ...a, acknowledged: true, acknowledged_by: operatorRef.current, acknowledged_at: new Date().toISOString() }
      : a));
    if (announce) {
      const fresh = newAlertIds(alertsRef.current, merged);
      if (fresh.length > 0 && !reduced) {
        setFlash(new Set(fresh));
        setTimeout(() => setFlash(new Set()), 1000);
      }
    }
    alertsRef.current = merged;
    setAlerts(merged);
  }, [reduced]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      apply((await fetchAlerts()) as TriageAlert[], false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load alerts');
    } finally {
      setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    load();
    fetchBlacklistEntries().then(setEntries).catch(() => setEntries([]));
  }, [load]);

  // Poll for new alerts (fallback); newly arrived rows flash briefly.
  useEffect(() => {
    const id = setInterval(() => {
      fetchAlerts().then((d) => apply(d as TriageAlert[], true)).catch(() => {});
    }, POLL_MS);
    return () => clearInterval(id);
  }, [apply]);

  // Live events (live poll / replay): merge immediately.
  useEffect(
    () =>
      subscribeAlertEvents((e) => {
        apply(applyAlertEvent(alertsRef.current, e), e.type === 'insert');
        if (e.type === 'insert') setSelectedId((cur) => cur ?? e.alert.id);
      }),
    [apply],
  );

  // Replay started / stopped / scrubbed: the set of alerts that exist changes.
  useEffect(
    () =>
      subscribeReplay((prev, next, change) => {
        if (change === 'tick' || (prev.active === next.active && prev.clock === next.clock)) return;
        fetchAlerts().then((d) => apply(d as TriageAlert[], false)).catch(() => {});
      }),
    [apply],
  );

  const handleAcknowledge = (target: TriageAlert) => guard('acknowledge alerts', () => void acknowledge(target));

  const acknowledge = async (target: TriageAlert) => {
    const OPERATOR = operator;
    const id = target.id;
    const before = alertsRef.current;
    pendingAcks.current.add(id);
    const next = before.map((a) => (a.id === id ? { ...a, acknowledged: true, acknowledged_by: OPERATOR, acknowledged_at: new Date().toISOString() } : a));
    alertsRef.current = next;
    setAlerts(next);
    try {
      await acknowledgeAlert(id, OPERATOR);
      toast({ tone: 'success', title: 'Alert acknowledged', description: `${target.plate_text} at ${target.camera_name}` });
    } catch (err) {
      pendingAcks.current.delete(id);
      alertsRef.current = alertsRef.current.map((a) => (a.id === id ? before.find((b) => b.id === id) ?? a : a));
      setAlerts(alertsRef.current);
      toast({ tone: 'danger', title: 'Could not acknowledge alert', description: err instanceof Error ? err.message : 'Please try again.' });
    }
  };

  const cameraOptions = useMemo(
    () => [...new Map(alerts.map((a) => [a.camera_name, cameraCodeOf(a)])).entries()].sort((x, y) => x[0].localeCompare(y[0])),
    [alerts],
  );

  const filtered = useMemo(
    () =>
      sortForTriage(
        alerts.filter((a) => {
          if (priorityFilter !== 'all' && a.priority !== priorityFilter) return false;
          if (statusFilter === 'unack' && a.acknowledged) return false;
          if (statusFilter === 'ack' && !a.acknowledged) return false;
          if (cameraFilter !== 'all' && a.camera_name !== cameraFilter) return false;
          if (typeFilter === 'watchlist' && alertKind(a) !== 'watchlist') return false;
          if (typeFilter === 'anomaly' && alertKind(a) === 'watchlist') return false;
          return true;
        }),
      ),
    [alerts, priorityFilter, statusFilter, cameraFilter, typeFilter],
  );

  // Selection falls back to the top of the queue (e.g. after acknowledging).
  const selected = filtered.find((a) => a.id === selectedId) ?? filtered[0] ?? null;
  const entry = selected ? entries.find((e) => e.id === selected.blacklist_entry_id || normalizePlate(e.plate_text) === normalizePlate(selected.plate_text)) ?? null : null;

  const pending = alerts.filter((a) => !a.acknowledged);
  const critical = pending.filter((a) => a.priority === 'critical').length;
  const high = pending.filter((a) => a.priority === 'high').length;
  const acked = alerts.length - pending.length;
  const mtta = medianAckSeconds(alerts);
  const simulated = alerts.some((a) => a.simulated);

  const filters = (
    <>
      <Select aria-label="Filter by severity" label="Severity" uiSize="sm" value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)}>
        <option value="all">All</option>
        <option value="critical">Critical</option>
        <option value="high">High</option>
        <option value="medium">Medium</option>
        <option value="low">Low</option>
      </Select>
      <Select aria-label="Filter by status" label="Status" uiSize="sm" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
        <option value="unack">Pending</option>
        <option value="ack">Acknowledged</option>
        <option value="all">All</option>
      </Select>
      <Select aria-label="Filter by type" label="Type" uiSize="sm" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
        <option value="all">All</option>
        <option value="watchlist">Watchlist hits</option>
        <option value="anomaly">Route anomalies</option>
      </Select>
      <Select aria-label="Filter by camera" label="Camera" uiSize="sm" value={cameraFilter} onChange={(e) => setCameraFilter(e.target.value)}>
        <option value="all">All cameras</option>
        {cameraOptions.map(([name, code]) => (
          <option key={name} value={name}>{code ? `${code} · ${name}` : name}</option>
        ))}
      </Select>
    </>
  );

  return (
    <Page>
      <PageHeader
        title="Alerts"
        icon={SirenIcon}
        description="Watchlist hits and suspicious route anomalies raised by the ANPR network"
        meta={
          <>
            {!loading && !error && (pending.length > 0 ? (
              <Badge tone="danger" variant="solid" size="md">{pending.length} Pending Action</Badge>
            ) : (
              <Badge tone="success" size="md" icon={<CircleCheckIcon />}>All clear</Badge>
            ))}
            {simulated && <SimulationBadge />}
          </>
        }
        actions={<ReplayControls />}
      />

      <Toolbar>{filters}</Toolbar>

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <>
          <KpiStrip>
            <KpiTile label="Critical open" tone="danger" icon={<OctagonAlertIcon size={16} strokeWidth={1.75} />} value={critical} loading={loading} />
            <KpiTile label="High open" tone="warning" icon={<TriangleAlertIcon size={16} strokeWidth={1.75} />} value={high} loading={loading} />
            <KpiTile label="Pending total" icon={<ShieldAlertIcon size={16} strokeWidth={1.75} />} value={pending.length} loading={loading} hint={`${alerts.length} alerts on record`} />
            <KpiTile label="Acknowledged" tone="success" icon={<UserRoundCheckIcon size={16} strokeWidth={1.75} />} value={acked} loading={loading} />
            <KpiTile label="Median time to ack" icon={<TimerIcon size={16} strokeWidth={1.75} />} value={mtta == null ? '—' : formatDuration(mtta)} loading={loading} />
          </KpiStrip>

          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
            <Panel
              title="Triage queue"
              subtitle={loading ? undefined : `${filtered.length} shown · severity, then newest`}
              flush
              actions={<IconButton size="sm" label="Refresh alerts" icon={<RefreshCwIcon size={14} />} onClick={load} />}
            >
              {loading ? (
                <div className="divide-y divide-line">
                  {Array.from({ length: 6 }, (_, i) => (
                    <div key={i} className="flex items-center gap-3 px-4 py-3">
                      <Skeleton className="h-5 w-16" />
                      <Skeleton className="h-6 w-28" />
                      <Skeleton className="h-4 flex-1" />
                      <Skeleton className="h-7 w-24" />
                    </div>
                  ))}
                </div>
              ) : filtered.length === 0 ? (
                <EmptyState
                  icon={<ShieldAlertIcon size={20} />}
                  title="No Watchlist Alerts Found"
                  description="No alerts match the selected filters."
                />
              ) : (
                <ul className="divide-y divide-line" aria-label="Alerts">
                  {filtered.map((a) => {
                    const isSel = selected?.id === a.id;
                    const code = cameraCodeOf(a);
                    return (
                      <li
                        key={a.id}
                        tabIndex={0}
                        aria-current={isSel ? 'true' : undefined}
                        onClick={() => setSelectedId(a.id)}
                        onKeyDown={(e) => {
                          if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                            e.preventDefault();
                            setSelectedId(a.id);
                          }
                        }}
                        className={cn(
                          'relative flex cursor-pointer flex-col gap-2 px-4 py-2.5 transition-colors duration-700 sm:flex-row sm:items-center sm:gap-3',
                          'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
                          isSel ? 'bg-primary/8' : 'hover:bg-surface-2',
                          flash.has(a.id) && 'bg-danger/12',
                        )}
                      >
                        {!a.acknowledged && <span aria-hidden className={cn('absolute inset-y-0 left-0 w-[3px]', SEV_BAR[a.priority])} />}
                        <div className={cn('min-w-0 flex-1 space-y-1', a.acknowledged && 'text-fg-muted')}>
                          <div className="flex flex-wrap items-center gap-2">
                            <SeverityChip severity={a.priority} size="sm" />
                            <PlateChip plate={a.plate_text} size="sm" flag={a.acknowledged ? null : plateFlag(a)} />
                            <KindBadge alert={a} />
                          </div>
                          <p className={cn('truncate text-[13px] font-medium', a.acknowledged ? 'text-fg-muted' : 'text-fg')}>{a.reason}</p>
                          <p className="flex flex-wrap items-center gap-x-2 text-xs text-fg-muted">
                            {code && <span className="font-mono">{code}</span>}
                            <span>{a.camera_name}</span>
                            <span aria-hidden className="text-fg-subtle">·</span>
                            <AlertTime iso={a.timestamp} />
                            {a.acknowledged && (
                              <>
                                <span aria-hidden className="text-fg-subtle">·</span>
                                <span className="inline-flex items-center gap-1 text-success">
                                  <CircleCheckIcon size={12} aria-hidden />
                                  Acknowledged by {a.acknowledged_by ?? 'operator'}
                                  {a.acknowledged_at && ` · ${formatIstTime(a.acknowledged_at).slice(0, 5)}`}
                                </span>
                              </>
                            )}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                          {!a.acknowledged && (
                            <Button size="sm" variant="success" icon={<CheckIcon size={14} />} onClick={() => handleAcknowledge(a)}>
                              Acknowledge
                            </Button>
                          )}
                          <IconButton size="sm" variant="secondary" label={`View route of ${a.plate_text}`} icon={<RouteIcon size={14} />} onClick={() => navigate(routeUrl(a.plate_text))} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>

            <Panel title="Alert detail" className="lg:sticky lg:top-4">
              {loading ? (
                <SkeletonPanel height={420} />
              ) : selected ? (
                <AlertDetail key={selected.id} alert={selected} entry={entry} onAcknowledge={handleAcknowledge} />
              ) : (
                <EmptyState compact icon={<ShieldAlertIcon size={20} />} title="Select an alert to triage" />
              )}
            </Panel>
          </div>
        </>
      )}
    </Page>
  );
}

export default AlertsPage;
