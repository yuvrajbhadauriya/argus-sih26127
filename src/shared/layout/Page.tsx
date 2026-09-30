// ═══════════════════════════════════════════════════
// Page / PageHeader — page wrapper and title row used by every screen
// ═══════════════════════════════════════════════════

import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/shared/lib/cn';

export function Page({ children, fullBleed = false, className }: { children: ReactNode; fullBleed?: boolean; className?: string }) {
  return (
    <div
      className={cn(
        fullBleed ? 'flex h-full min-h-0 flex-col gap-3 p-3 lg:p-4' : 'space-y-4 p-4 lg:p-5',
        'animate-fade-in',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  icon: Icon,
  meta,
  actions,
  className,
}: {
  title: string;
  description?: ReactNode;
  icon?: LucideIcon;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-3 md:flex-row md:items-center md:justify-between', className)}>
      <div className="flex min-w-0 items-start gap-2.5">
        {Icon && (
          <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-line bg-surface text-primary" aria-hidden>
            <Icon size={16} strokeWidth={1.75} />
          </span>
        )}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold leading-6 tracking-[-0.01em] text-fg">{title}</h1>
            {meta}
          </div>
          {description && <p className="mt-0.5 text-xs text-fg-muted">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
