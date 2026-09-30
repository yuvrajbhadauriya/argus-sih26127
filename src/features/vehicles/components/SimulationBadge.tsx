// ═══════════════════════════════════════════════════
// SimulationBadge — marks simulated city-network data
// Toggle globally with SHOW_SIMULATION_BADGE (features/vehicles/config.ts)
// ═══════════════════════════════════════════════════

import { FlaskConicalIcon } from 'lucide-react';
import { Badge } from '@/shared/ui/Badge';
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
      className={className}
      title="Camera clips are stock footage pinned to real Delhi junctions; cross-camera journeys are simulated on the real road network."
    >
      Simulated city network
    </Badge>
  );
}
