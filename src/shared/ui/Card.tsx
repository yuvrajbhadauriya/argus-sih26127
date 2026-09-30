// ═══════════════════════════════════════════════════
// Card / CardHeader / Panel — level-1 surfaces (surface + 1px line, no shadow)
// ═══════════════════════════════════════════════════

import type { ReactNode } from 'react';
import { cn } from '@/shared/lib/cn';

interface CardProps {
  children: ReactNode;
  className?: string;
  hover?: boolean;
  onClick?: () => void;
  id?: string;
  padding?: 'none' | 'sm' | 'md';
  selected?: boolean;
}

const PAD = { none: '', sm: 'p-3', md: 'p-4' } as const;

export function Card({ children, className, hover = false, onClick, id, padding = 'md', selected = false }: CardProps) {
  return (
    <div
      id={id}
      data-selected={selected || undefined}
      className={cn(
        'rounded-md border bg-surface',
        selected ? 'border-primary/60 bg-primary/5' : 'border-line',
        PAD[padding],
        (hover || onClick) && 'cursor-pointer transition-colors hover:border-line-strong hover:bg-surface-2',
        className,
      )}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                if (e.key === ' ') e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      {children}
    </div>
  );
}

interface CardHeaderProps {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  icon?: ReactNode;
}

export function CardHeader({ title, subtitle, action, icon }: CardHeaderProps) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-2">
        {icon && <span className="mt-0.5 inline-flex text-fg-subtle" aria-hidden>{icon}</span>}
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold leading-[18px] text-fg">{title}</h3>
          {subtitle && <p className="mt-0.5 text-xs text-fg-muted">{subtitle}</p>}
        </div>
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

export interface PanelProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Body without padding (tables, maps). */
  flush?: boolean;
  /** Body scrolls (overflow-y-auto, min-h-0); panel becomes a flex column. */
  scroll?: boolean;
  className?: string;
  bodyClassName?: string;
  id?: string;
}

export function Panel({ title, subtitle, icon, actions, children, footer, flush = false, scroll = false, className, bodyClassName, id }: PanelProps) {
  const hasHeader = title != null || actions != null;
  return (
    <section
      id={id}
      className={cn('flex min-w-0 flex-col overflow-hidden rounded-md border border-line bg-surface', scroll && 'min-h-0', className)}
    >
      {hasHeader && (
        <header className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-line px-4">
          <div className="flex min-w-0 items-center gap-2">
            {icon && <span className="inline-flex shrink-0 text-fg-subtle [&>svg]:h-4 [&>svg]:w-4" aria-hidden>{icon}</span>}
            {title != null && <h2 className="truncate text-[13px] font-semibold text-fg">{title}</h2>}
            {subtitle != null && <span className="truncate text-xs text-fg-muted">{subtitle}</span>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn(!flush && 'p-4', scroll ? 'min-h-0 flex-1 overflow-y-auto' : 'flex-1', bodyClassName)}>{children}</div>
      {footer && <footer className="shrink-0 border-t border-line px-4 py-2.5 text-xs text-fg-muted">{footer}</footer>}
    </section>
  );
}
