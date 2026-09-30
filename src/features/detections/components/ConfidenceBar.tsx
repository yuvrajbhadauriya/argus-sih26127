// Confidence as a small bar + tabular percentage.
// ≥ 0.90 success, ≥ 0.75 warning, below that danger (text also carries the value).

function confidenceTone(v: number): 'success' | 'warning' | 'danger' {
  return v >= 0.9 ? 'success' : v >= 0.75 ? 'warning' : 'danger';
}

const FILL = { success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger' } as const;

export function ConfidenceBar({ value, className = '' }: { value: number; className?: string }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  const tone = confidenceTone(value);
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <span className="relative h-1.5 w-[60px] overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
        <span className={`absolute inset-y-0 left-0 rounded-full ${FILL[tone]}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="w-10 text-right font-mono text-xs tabular-nums text-fg">{Math.round(pct)}%</span>
    </span>
  );
}
