// ═══════════════════════════════════════════════════
// SimulationBadge — marks simulated city-network data
// Toggle globally with SHOW_SIMULATION_BADGE (features/vehicles/config.ts)
// ═══════════════════════════════════════════════════

import { FlaskConicalIcon } from 'lucide-react';
import { SHOW_SIMULATION_BADGE } from '../config';

interface SimulationBadgeProps {
  className?: string;
  /** Compact variant for map overlays */
  compact?: boolean;
}

export function SimulationBadge({ className = '', compact = false }: SimulationBadgeProps) {
  if (!SHOW_SIMULATION_BADGE) return null;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border border-amber-400/30 bg-amber-400/10 font-semibold text-amber-300 ${
        compact ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-0.5 text-[11px]'
      } ${className}`}
      title="Camera clips are stock footage pinned to real Delhi junctions; cross-camera journeys are simulated on the real road network."
    >
      <FlaskConicalIcon size={compact ? 10 : 12} aria-hidden="true" />
      Simulated city network
    </span>
  );
}
