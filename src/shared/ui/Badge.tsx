// ═══════════════════════════════════════════════════
// Badge — small label with a semantic tone
// ═══════════════════════════════════════════════════

import type { ReactNode } from 'react';
import { cn } from '@/shared/lib/cn';

export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

export interface BadgeProps {
  children: ReactNode;
  tone?: Tone;
  variant?: 'subtle' | 'solid' | 'outline';
  size?: 'sm' | 'md';
  icon?: ReactNode;
  className?: string;
  title?: string;
}

const SUBTLE: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-fg-muted border-line',
  primary: 'bg-primary/12 text-primary border-primary/35',
  success: 'bg-success/12 text-success border-success/35',
  warning: 'bg-warning/12 text-warning border-warning/35',
  danger: 'bg-danger/12 text-danger border-danger/35',
  info: 'bg-info/12 text-info border-info/35',
};

const SOLID: Record<Tone, string> = {
  neutral: 'bg-fg-muted text-surface border-transparent',
  primary: 'bg-primary-solid text-on-primary border-transparent',
  success: 'bg-success text-white border-transparent dark:text-canvas',
  warning: 'bg-warning text-white border-transparent dark:text-canvas',
  danger: 'bg-danger-solid text-white border-transparent',
  info: 'bg-info text-white border-transparent dark:text-canvas',
};

const OUTLINE: Record<Tone, string> = {
  neutral: 'text-fg-muted border-line-strong',
  primary: 'text-primary border-primary/50',
  success: 'text-success border-success/50',
  warning: 'text-warning border-warning/50',
  danger: 'text-danger border-danger/50',
  info: 'text-info border-info/50',
};

export function Badge({ children, tone = 'neutral', variant = 'subtle', size = 'sm', icon, className, title }: BadgeProps) {
  const toneCls = variant === 'solid' ? SOLID[tone] : variant === 'outline' ? OUTLINE[tone] : SUBTLE[tone];
  return (
    <span
      title={title}
      data-tone={tone}
      data-variant={variant}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border font-medium tabular-nums leading-none',
        size === 'sm' ? 'h-5 px-1.5 text-2xs' : 'h-6 px-2 text-xs',
        toneCls,
        className,
      )}
    >
      {icon && <span className="inline-flex shrink-0 [&>svg]:h-3 [&>svg]:w-3" aria-hidden>{icon}</span>}
      {children}
    </span>
  );
}
