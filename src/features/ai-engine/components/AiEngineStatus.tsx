// ═══════════════════════════════════════════════════
// AiEngineStatusPill — the AI engine heartbeat (public.model_status) as a
// pill with a details popover.
//   variant="compact"  top bar: dot + short label (dot only on narrow screens)
//   variant="panel"    Cameras page: full-width row with the detail line
// Shows a generic engine name only — never the model architecture.
// ═══════════════════════════════════════════════════

import { cn } from '@/shared/lib/cn';
import { Popover } from '@/shared/ui/Popover';
import { formatIstTime } from '@/shared/lib/time';
import { useAiEngineStatus } from '../hooks/useAiEngineStatus';
import { engineDetail, formatAgo, formatUptime, type EngineTone, type EngineView } from '../lib/status';

const DOT: Record<EngineTone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  neutral: 'bg-fg-subtle',
};
const TEXT: Record<EngineTone, string> = {
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  neutral: 'text-fg-muted',
};

function Dot({ tone, pulse }: { tone: EngineTone; pulse?: boolean }) {
  return (
    <span aria-hidden className="relative inline-flex h-2 w-2 shrink-0">
      {pulse && <span className={cn('absolute inset-0 animate-ping rounded-full opacity-60', DOT[tone])} />}
      <span className={cn('relative inline-flex h-2 w-2 rounded-full', DOT[tone])} />
    </span>
  );
}

function Details({ v }: { v: EngineView }) {
  const now = v.now;
  return (
    <>
      <div className="border-b border-line px-3 py-2.5">
        <div className="text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">{v.engineLabel}</div>
        <div className={cn('mt-0.5 text-[13px] font-semibold', TEXT[v.tone])}>{v.label}</div>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 px-3 py-2.5 text-xs">
        {v.uptimeSeconds != null && (
          <>
            <dt className="text-fg-muted">Uptime</dt>
            <dd className="text-right font-medium tabular-nums text-fg">{formatUptime(v.uptimeSeconds)}</dd>
          </>
        )}
        {v.remainingSeconds != null && (
          <>
            <dt className="text-fg-muted">Ready in</dt>
            <dd className="text-right font-medium tabular-nums text-fg">{v.remainingSeconds > 0 ? `${v.remainingSeconds} s` : 'any moment'}</dd>
          </>
        )}
        {v.gpuBusy != null && v.kind !== 'demo' && (
          <>
            <dt className="text-fg-muted">GPU</dt>
            <dd className="text-right text-fg">{v.gpuBusy ? 'Busy' : 'Idle'}</dd>
          </>
        )}
        {v.restarts != null && (
          <>
            <dt className="text-fg-muted">Restarts</dt>
            <dd className="text-right tabular-nums text-fg">{v.restarts}</dd>
          </>
        )}
        <dt className="text-fg-muted">Last heartbeat</dt>
        <dd className="text-right tabular-nums text-fg">
          {v.lastSeenAt != null ? `${formatIstTime(v.lastSeenAt)} IST · ${formatAgo(v.lastSeenAt, now)}` : '—'}
        </dd>
      </dl>
      <p className="border-t border-line px-3 py-2.5 text-xs text-fg-muted">
        {v.message && v.kind !== 'starting' ? `${v.message} · ` : ''}
        {v.kind === 'demo'
          ? 'This build has no database, so the GPU engine heartbeat is not available. Recorded detections are shown on the feeds.'
          : 'Plate detection and OCR run on the team’s GPU server; the dashboard shows its heartbeat live.'}
      </p>
    </>
  );
}

export interface AiEngineStatusPillProps {
  className?: string;
  variant?: 'compact' | 'panel';
}

export function AiEngineStatusPill({ className, variant = 'compact' }: AiEngineStatusPillProps) {
  const v = useAiEngineStatus();
  const pulse = v.kind === 'starting';

  if (variant === 'compact') {
    // Top bar: nothing to report without a database.
    if (v.kind === 'demo') return null;
    return (
      <Popover
        className={className}
        triggerLabel={`${v.engineLabel}: ${v.label}`}
        triggerClassName="inline-flex h-8 items-center gap-2 rounded-full border border-line px-2.5 text-xs font-medium text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg max-md:w-8 max-md:justify-center max-md:px-0"
        trigger={
          <>
            <Dot tone={v.tone} pulse={pulse} />
            <span className={cn('hidden whitespace-nowrap tabular-nums md:inline', TEXT[v.tone])}>
              <span className="lg:hidden">{v.kind === 'online' ? 'AI online' : v.kind === 'starting' ? (v.remainingSeconds ? `AI ${v.remainingSeconds}s` : 'AI starting') : v.kind === 'loading' ? 'AI…' : 'AI offline'}</span>
              <span className="hidden lg:inline">{v.label}</span>
            </span>
          </>
        }
        panelClassName="w-72"
      >
        <Details v={v} />
      </Popover>
    );
  }

  return (
    <Popover
      className={cn('w-full', className)}
      align="start"
      triggerLabel={`${v.engineLabel}: ${v.label}. ${engineDetail(v)}`}
      triggerClassName="flex w-full items-center gap-3 rounded-md border border-line bg-surface px-3 py-2.5 text-left transition-colors hover:bg-surface-2"
      trigger={
        <>
          <Dot tone={v.tone} pulse={pulse} />
          <span className="min-w-0 flex-1">
            <span className={cn('block truncate text-[13px] font-semibold tabular-nums', TEXT[v.tone])}>{v.label}</span>
            <span className="block truncate text-xs text-fg-muted">
              {v.engineLabel} · {engineDetail(v)}
            </span>
          </span>
        </>
      }
      panelClassName="w-72"
    >
      <Details v={v} />
    </Popover>
  );
}

export default AiEngineStatusPill;
