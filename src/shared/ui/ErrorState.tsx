// ═══════════════════════════════════════════════════
// ErrorState — Consistent error display with optional retry
// ═══════════════════════════════════════════════════

import { RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { Button } from './Button';

interface ErrorStateProps {
  message?: string;
  onRetry?: () => void;
  title?: string;
  compact?: boolean;
  className?: string;
}

export function ErrorState({ message = 'Something went wrong', onRetry, title = 'Error', compact = false, className }: ErrorStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-4 text-center', compact ? 'py-8' : 'py-16', className)}>
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-md bg-danger/12 text-danger" aria-hidden>
        <TriangleAlertIcon size={20} strokeWidth={1.75} />
      </div>
      <h3 className="text-[13px] font-semibold text-fg">{title}</h3>
      <p className="mt-1 max-w-sm text-xs text-fg-muted">{message}</p>
      {onRetry && (
        <Button className="mt-4" size="sm" icon={<RefreshCwIcon size={14} />} onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
