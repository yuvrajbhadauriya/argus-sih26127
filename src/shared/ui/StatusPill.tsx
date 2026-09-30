// ═══════════════════════════════════════════════════
// StatusPill — operational status (dot + label). Colour is never the only cue.
// ═══════════════════════════════════════════════════

import { cn } from '@/shared/lib/cn';

export type OpStatus = 'online' | 'offline' | 'maintenance' | 'degraded' | 'live' | 'connecting' | 'paused' | 'idle';

const STYLE: Record<OpStatus, { pill: string; dot: string; label: string }> = {
  online: { pill: 'bg-success/12 text-success border-success/35', dot: 'bg-success', label: 'Online' },
  live: { pill: 'bg-success/12 text-success border-success/35', dot: 'bg-success', label: 'Live' },
  offline: { pill: 'bg-danger/12 text-danger border-danger/35', dot: 'bg-danger', label: 'Offline' },
  maintenance: { pill: 'bg-warning/12 text-warning border-warning/35', dot: 'bg-warning', label: 'Maintenance' },
  degraded: { pill: 'bg-warning/12 text-warning border-warning/35', dot: 'bg-warning', label: 'Degraded' },
  connecting: { pill: 'bg-info/12 text-info border-info/35', dot: 'bg-info', label: 'Connecting' },
  paused: { pill: 'bg-surface-2 text-fg-muted border-line', dot: 'bg-fg-subtle', label: 'Paused' },
  idle: { pill: 'bg-surface-2 text-fg-muted border-line', dot: 'bg-fg-subtle', label: 'Idle' },
};

export function StatusPill({
  status,
  label,
  pulse = false,
  size = 'sm',
  className,
}: {
  status: OpStatus;
  label?: string;
  pulse?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const s = STYLE[status] ?? STYLE.idle;
  return (
    <span
      data-status={status}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border font-medium leading-none',
        size === 'sm' ? 'h-5 px-2 text-2xs' : 'h-6 px-2.5 text-xs',
        s.pill,
        className,
      )}
    >
      <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', s.dot, pulse && 'animate-live-pulse')} />
      {label ?? s.label}
    </span>
  );
}
