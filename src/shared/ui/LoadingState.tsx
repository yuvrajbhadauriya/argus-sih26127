// ═══════════════════════════════════════════════════
// LoadingState — Consistent loading spinner
// ═══════════════════════════════════════════════════

import { cn } from '@/shared/lib/cn';

interface LoadingStateProps {
  message?: string;
  className?: string;
}

export function LoadingState({ message = 'Loading...', className }: LoadingStateProps) {
  return (
    <div role="status" className={cn('flex flex-col items-center justify-center py-16', className)}>
      <div className="relative h-8 w-8" aria-hidden>
        <div className="absolute inset-0 rounded-full border-2 border-line" />
        <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-primary" />
      </div>
      <p className="mt-3 text-xs text-fg-muted">{message}</p>
    </div>
  );
}
