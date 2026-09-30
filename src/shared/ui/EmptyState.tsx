// ═══════════════════════════════════════════════════
// EmptyState — Consistent empty/no-data display
// ═══════════════════════════════════════════════════

import { InboxIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/shared/lib/cn';

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
}

export function EmptyState({ icon, title, description, action, compact = false, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-4 text-center', compact ? 'py-8' : 'py-16', className)}>
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-md bg-surface-2 text-fg-subtle [&>svg]:h-5 [&>svg]:w-5" aria-hidden>
        {icon ?? <InboxIcon size={20} strokeWidth={1.75} />}
      </div>
      <h3 className="text-[13px] font-semibold text-fg">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-xs text-fg-muted">{description}</p>}
      {action && <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}
