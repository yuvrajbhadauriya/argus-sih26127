// ═══════════════════════════════════════════════════
// StatusBadge — compatibility wrapper. New code should use StatusPill
// (camera/feed status), SeverityChip (priority) or Badge directly.
// ═══════════════════════════════════════════════════

import type { CameraStatus, AlertPriority } from '@/types';
import { StatusPill } from './StatusPill';
import { SeverityChip } from './SeverityChip';
import { Badge } from './Badge';

type BadgeVariant = CameraStatus | AlertPriority | 'info';

interface StatusBadgeProps {
  variant: BadgeVariant;
  label?: string;
  pulse?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

export function StatusBadge({ variant, label, pulse = false, size = 'sm', className }: StatusBadgeProps) {
  let inner;
  if (variant === 'online' || variant === 'offline' || variant === 'maintenance') {
    inner = <StatusPill status={variant} label={label} pulse={pulse} size={size} />;
  } else if (variant === 'info') {
    inner = <Badge tone="info" size={size}>{label ?? 'Info'}</Badge>;
  } else {
    inner = <SeverityChip severity={variant} label={label} size={size} />;
  }
  return (
    <span data-variant={variant} className={className ? `inline-flex ${className}` : 'inline-flex'}>
      {inner}
    </span>
  );
}
