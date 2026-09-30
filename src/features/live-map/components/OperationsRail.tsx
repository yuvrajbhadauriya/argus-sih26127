// Right rail of the Live Map: Live feed | Alerts | Cameras.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRightIcon, CctvIcon, ListIcon, RadioIcon, SirenIcon } from 'lucide-react';
import type { AlertRecord } from '@/types';
import type { Camera } from '@/types/camera';
import type { LiveFeedEntry } from '@/mocks/fixtures/mockLiveFeed';
import { Panel } from '@/shared/ui/Card';
import { Tabs, TabPanel } from '@/shared/ui/Tabs';
import { Badge } from '@/shared/ui/Badge';
import { PlateChip } from '@/shared/ui/PlateChip';
import { SeverityChip } from '@/shared/ui/SeverityChip';
import { StatusPill } from '@/shared/ui/StatusPill';
import { EmptyState } from '@/shared/ui/EmptyState';
import { ErrorState } from '@/shared/ui/ErrorState';
import { SkeletonRows } from '@/shared/ui/Skeleton';
import { normalizePlate } from '@/shared/lib/plate';
import { SimulationBadge } from '@/features/vehicles/components/SimulationBadge';
import { formatIstTime, formatRelative } from '../lib/time';

type RailTab = 'feed' | 'alerts' | 'cameras';

interface OperationsRailProps {
  feed: LiveFeedEntry[];
  alerts: AlertRecord[];
  /** Total open alerts (the list may be truncated) */
  alertCount: number;
  alertsLoading: boolean;
  alertsError: string | null;
  onRetryAlerts: () => void;
  cameras: Camera[];
  selectedCode: string | null;
  onPickCamera: (camera: Camera) => void;
  /** "Replay the day" is running: the feed follows the replay clock. */
  replaying?: boolean;
  className?: string;
}

const ROW = 'flex w-full items-center gap-3 border-b border-line px-3 text-left transition-colors hover:bg-surface-2 focus-visible:bg-surface-2';

function FeedRow({ entry }: { entry: LiveFeedEntry }) {
  const navigate = useNavigate();
  const hit = entry.watchlist != null;
  return (
    <li>
      <button
        type="button"
        onClick={() => navigate(`/vehicles?plate=${encodeURIComponent(normalizePlate(entry.plate))}`)}
        className={`${ROW} relative h-14`}
        aria-label={`Trace ${entry.plate} seen at ${entry.cameraName}`}
      >
        {hit && <span className="absolute inset-y-0 left-0 w-0.5 bg-danger" aria-hidden="true" />}
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <PlateChip plate={entry.plate} size="sm" variant={entry.plateVariant} flag={hit ? 'watchlist' : null} />
            {hit && <SeverityChip severity={entry.watchlist!} size="sm" />}
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
            <span className="font-mono font-medium">{entry.cameraCode}</span>
            <span className="truncate">{entry.cameraName}</span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge tone={entry.confidence >= 90 ? 'success' : 'warning'} size="sm" className="tabular-nums">{`${entry.confidence}%`}</Badge>
          <span className="text-2xs tabular-nums text-fg-subtle">{entry.secondsAgo}s ago</span>
        </div>
      </button>
    </li>
  );
}

function AlertRow({ alert }: { alert: AlertRecord }) {
  return (
    <li>
      <Link to="/alerts" className={`${ROW} relative h-14`}>
        <span className="absolute inset-y-0 left-0 w-0.5" style={{ background: `var(--sev-${alert.priority})` }} aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <SeverityChip severity={alert.priority} size="sm" />
            <PlateChip plate={alert.plate_text} size="xs" />
          </div>
          <p className="truncate text-xs text-fg-muted">{alert.camera_name}</p>
        </div>
        <span className="shrink-0 text-right font-mono text-2xs tabular-nums text-fg-muted" title={formatRelative(alert.timestamp)}>
          {formatIstTime(alert.timestamp)}
        </span>
      </Link>
    </li>
  );
}

export function OperationsRail({
  feed, alerts, alertCount, alertsLoading, alertsError, onRetryAlerts, cameras, selectedCode, onPickCamera, replaying = false, className,
}: OperationsRailProps) {
  const [tab, setTab] = useState<RailTab>('feed');
  const watchHits = feed.filter((f) => f.watchlist).length;

  return (
    <Panel
      className={className}
      title="Operations"
      icon={<RadioIcon />}
      actions={
        tab === 'feed' ? (
          replaying ? (
            <span className="flex items-center gap-1.5"><Badge tone="danger" size="sm">Replay · live</Badge><SimulationBadge compact /></span>
          ) : (
            <Badge tone="success" size="sm" title="Plates read by the AI ANPR engine on the camera clips (OCR ≥ 75 %, valid format), streaming on each camera's live clock">
              Real ANPR reads
            </Badge>
          )
        ) : undefined
      }
      flush
      bodyClassName="flex min-h-0 flex-col"
    >
      <Tabs
        ariaLabel="Operations"
        size="sm"
        value={tab}
        onChange={(id) => setTab(id as RailTab)}
        className="shrink-0 px-3"
        items={[
          { id: 'feed', label: 'Live feed', icon: <ListIcon size={14} strokeWidth={1.75} />, count: watchHits || undefined },
          { id: 'alerts', label: 'Alerts', icon: <SirenIcon size={14} strokeWidth={1.75} />, count: alertCount || undefined },
          { id: 'cameras', label: 'Cameras', icon: <CctvIcon size={14} strokeWidth={1.75} />, count: cameras.length || undefined },
        ]}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <TabPanel id="feed" active={tab === 'feed'}>
          {feed.length === 0 ? (
            <EmptyState compact icon={<ListIcon size={20} />} title="Waiting for plate reads" description="Reads appear as vehicles pass the cameras." />
          ) : (
            <ul aria-label="Latest plate reads">
              {feed.map((e) => <FeedRow key={e.id} entry={e} />)}
            </ul>
          )}
        </TabPanel>

        <TabPanel id="alerts" active={tab === 'alerts'}>
          {alertsLoading ? (
            <div className="p-3"><SkeletonRows rows={6} cols={2} /></div>
          ) : alertsError ? (
            <ErrorState compact title="Alerts unavailable" message={alertsError} onRetry={onRetryAlerts} />
          ) : alerts.length === 0 ? (
            <EmptyState compact icon={<SirenIcon size={20} />} title="No open alerts" description="Watchlist hits will appear here." />
          ) : (
            <ul aria-label="Open alerts">
              {alerts.map((a) => <AlertRow key={a.id} alert={a} />)}
            </ul>
          )}
        </TabPanel>

        <TabPanel id="cameras" active={tab === 'cameras'}>
          <ul aria-label="Cameras">
            {cameras.map((c) => {
              const sel = c.code === selectedCode;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => onPickCamera(c)}
                    aria-current={sel ? 'true' : undefined}
                    className={`${ROW} relative h-10 ${sel ? 'bg-primary/8' : ''}`}
                  >
                    {sel && <span className="absolute inset-y-0 left-0 w-0.5 bg-primary" aria-hidden="true" />}
                    <span className="w-12 shrink-0 font-mono text-xs font-medium text-fg-muted">{c.code}</span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{c.name}</span>
                    <StatusPill status={c.status} size="sm" />
                  </button>
                </li>
              );
            })}
          </ul>
        </TabPanel>
      </div>

      {tab === 'alerts' && (
        <div className="shrink-0 border-t border-line px-4 py-2.5">
          <Link to="/alerts" className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
            View all alerts <ArrowRightIcon size={14} strokeWidth={1.75} aria-hidden="true" />
          </Link>
        </div>
      )}
    </Panel>
  );
}
