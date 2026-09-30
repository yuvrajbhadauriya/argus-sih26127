// ═══════════════════════════════════════════════════
// SimulationBadge — marks simulated city-network data
// Toggle globally with SHOW_SIMULATION_BADGE (features/vehicles/config.ts)
// ═══════════════════════════════════════════════════

import { FlaskConicalIcon } from 'lucide-react';
import { Badge } from '@/shared/ui/Badge';
import { cn } from '@/shared/lib/cn';
import { SHOW_SIMULATION_BADGE } from '../config';

interface SimulationBadgeProps {
  className?: string;
  /** Compact variant for map overlays and KPI hints */
  compact?: boolean;
}

export function SimulationBadge({ className, compact = false }: SimulationBadgeProps) {
  if (!SHOW_SIMULATION_BADGE) return null;
  return (
    <Badge
      tone="warning"
      size={compact ? 'sm' : 'md'}
      icon={<FlaskConicalIcon strokeWidth={1.75} />}
      // Truncates instead of overflowing narrow containers (e.g. KPI tile hints).
      className={cn('min-w-0 max-w-full shrink!', className)}
      title="Camera clips are stock footage pinned to real Delhi junctions; cross-camera journeys are simulated on the real road network."
    >
      <span className="min-w-0 truncate">Simulated city network</span>
    </Badge>
  );
}
