// ═══════════════════════════════════════════════════
// Skeleton placeholders
// ═══════════════════════════════════════════════════

import { cn } from '@/shared/lib/cn';

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded-sm bg-surface-3', className)} />;
}

export function SkeletonRows({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div role="status" aria-label="Loading" className="divide-y divide-line">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex h-8 items-center gap-4 px-3">
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} className={cn('h-3', c === 0 ? 'w-24' : 'flex-1', c === cols - 1 && cols > 1 && 'max-w-16')} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonPanel({ height = 240, className }: { height?: number | string; className?: string }) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className={cn('animate-pulse rounded-md border border-line bg-surface-2', className)}
      style={{ height: typeof height === 'number' ? `${height}px` : height }}
    />
  );
}
