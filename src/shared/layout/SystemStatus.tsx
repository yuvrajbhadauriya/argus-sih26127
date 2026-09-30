// ═══════════════════════════════════════════════════
// SystemStatus — camera network health pill + details popover (topbar).
// Loaded lazily by TopBar so the cameras data layer stays out of the entry chunk.
// ═══════════════════════════════════════════════════

import { Link } from 'react-router-dom';
import { cn } from '@/shared/lib/cn';
import { env } from '@/config/env';
import { useCameras } from '@/features/cameras/hooks/useCameras';
import { Popover } from '@/shared/ui/Popover';
import { StatusPill } from '@/shared/ui/StatusPill';

type Health = 'nominal' | 'degraded' | 'offline' | 'loading';

const HEALTH: Record<Health, { word: string; dot: string; text: string }> = {
  nominal: { word: 'Nominal', dot: 'bg-success', text: 'text-success' },
  degraded: { word: 'Degraded', dot: 'bg-warning', text: 'text-warning' },
  offline: { word: 'Offline', dot: 'bg-danger', text: 'text-danger' },
  loading: { word: 'Checking', dot: 'bg-fg-subtle', text: 'text-fg-muted' },
};

const liveBackend = Boolean(env.supabaseUrl?.startsWith('http') && env.supabaseAnonKey);

export function SystemStatus({ className }: { className?: string }) {
  const { cameras, loading, error } = useCameras();
  const total = cameras.length;
  const online = cameras.filter((c) => c.status === 'online').length;
  const offlineCams = cameras.filter((c) => c.status !== 'online');
  const health: Health = loading && total === 0 ? 'loading' : error || online === 0 ? 'offline' : online < total ? 'degraded' : 'nominal';
  const h = HEALTH[health];

  return (
    <Popover
      className={className}
      triggerLabel={`System status: ${online} of ${total} cameras online, ${h.word}`}
      triggerClassName="inline-flex h-8 items-center gap-2 rounded-full border border-line px-3 text-xs font-medium text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
      trigger={
        <>
          <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', h.dot)} />
          <span className="tabular-nums text-fg">
            {online}/{total}
          </span>
          <span className="hidden xl:inline">cameras</span>
          <span className={cn('hidden font-semibold lg:inline', h.text)}>{h.word}</span>
        </>
      }
      panelClassName="w-72"
    >
      <div className="border-b border-line px-3 py-2.5">
        <div className="text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">System status</div>
        <div className={cn('mt-0.5 text-[13px] font-semibold', h.text)}>{h.word}</div>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 px-3 py-2.5 text-xs">
        <dt className="text-fg-muted">Cameras online</dt>
        <dd className="text-right font-medium tabular-nums text-fg">
          {online} / {total}
        </dd>
        <dt className="text-fg-muted">Data source</dt>
        <dd className="text-right text-fg">{liveBackend ? 'Live Supabase' : 'Simulated city network'}</dd>
        <dt className="text-fg-muted">ANPR model</dt>
        <dd className="text-right text-fg">YOLOv7-tiny ANPR</dd>
      </dl>
      <div className="border-t border-line px-3 py-2.5">
        <div className="mb-1.5 text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">Offline cameras</div>
        {error ? (
          <p className="text-xs text-danger">{error}</p>
        ) : offlineCams.length === 0 ? (
          <p className="text-xs text-fg-muted">All cameras reporting.</p>
        ) : (
          <ul className="space-y-1">
            {offlineCams.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate">
                  <span className="font-mono font-medium text-fg">{c.code}</span> <span className="text-fg-muted">{c.name}</span>
                </span>
                <StatusPill status="offline" />
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="border-t border-line px-3 py-2">
        <Link to="/cameras" className="text-xs font-medium text-primary hover:underline">
          Open camera network
        </Link>
      </div>
    </Popover>
  );
}

export default SystemStatus;
