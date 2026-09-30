// ═══════════════════════════════════════════════════
// SeverityChip — alert / watchlist severity with icon + text
// ═══════════════════════════════════════════════════

import { CircleAlertIcon, InfoIcon, OctagonAlertIcon, TriangleAlertIcon } from 'lucide-react';
import { cn } from '@/shared/lib/cn';

export type Severity = 'critical' | 'high' | 'medium' | 'low';

// oxlint-disable-next-line react/only-export-components -- tiny sort map, part of the public API
export const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const ICON = { critical: OctagonAlertIcon, high: TriangleAlertIcon, medium: CircleAlertIcon, low: InfoIcon } as const;

const STYLE: Record<Severity, string> = {
  critical: 'bg-danger-solid text-white border-transparent',
  high: 'bg-sev-high/12 text-sev-high border-sev-high/35',
  medium: 'bg-sev-medium/12 text-sev-medium border-sev-medium/35',
  low: 'bg-sev-low/12 text-sev-low border-sev-low/35',
};

const LABEL: Record<Severity, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };

export function SeverityChip({
  severity,
  size = 'sm',
  showIcon = true,
  label,
  className,
}: {
  severity: Severity;
  size?: 'sm' | 'md';
  showIcon?: boolean;
  label?: string;
  className?: string;
}) {
  const Icon = ICON[severity] ?? InfoIcon;
  return (
    <span
      data-severity={severity}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border text-2xs font-semibold uppercase leading-none tracking-[0.04em]',
        size === 'sm' ? 'h-5 px-1.5' : 'h-6 px-2',
        STYLE[severity] ?? STYLE.low,
        className,
      )}
    >
      {showIcon && <Icon size={size === 'sm' ? 12 : 14} strokeWidth={2} aria-hidden />}
      {label ?? LABEL[severity] ?? severity}
    </span>
  );
}
