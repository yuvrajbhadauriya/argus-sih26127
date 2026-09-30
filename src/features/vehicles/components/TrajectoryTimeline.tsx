// ═══════════════════════════════════════════════════
// TrajectoryTimeline — chronological stop log synced with the map
// ═══════════════════════════════════════════════════

import { memo, useEffect, useRef } from 'react';
import { ArrowUpIcon, CircleSlashIcon } from 'lucide-react';
import type { Trajectory } from '@/types';
import {
  formatDistance,
  formatDuration,
  formatIstDate,
  formatIstTime,
  formatSpeed,
  headingLabel,
  headingToDegrees,
} from '../lib/geo';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';
import { tripColors } from '../lib/colors';

interface TrajectoryTimelineProps {
  trajectory: Trajectory;
  activeIndex: number | null;
  onSelect: (index: number) => void;
}

export const TrajectoryTimeline = memo(function TrajectoryTimeline({ trajectory, activeIndex, onSelect }: TrajectoryTimelineProps) {
  const reduced = usePrefersReducedMotion();
  const itemRefs = useRef<(HTMLLIElement | null)[]>([]);
  const colorFor = tripColors(trajectory);
  const flagged = new Set(trajectory.anomalies?.flatMap((a) => (a.kind === 'cloned_plate' ? a.waypoint_indices ?? [] : [])) ?? []);
  const w = trajectory.waypoints;

  useEffect(() => {
    if (activeIndex == null) return;
    const el = itemRefs.current[activeIndex];
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
    }
  }, [activeIndex, reduced]);

  const tripSpan = new Map<number, [number, number]>();
  for (const x of w) {
    const k = x.trip_index ?? 0;
    const t = Date.parse(x.timestamp);
    const span = tripSpan.get(k);
    tripSpan.set(k, span ? [Math.min(span[0], t), Math.max(span[1], t)] : [t, t]);
  }
  /** Does another trip of this plate overlap waypoint i in time? (cloned plate) */
  const conflicting = (i: number) => {
    const k = w[i].trip_index ?? 0;
    const t = Date.parse(w[i].timestamp);
    return [...tripSpan.entries()].some(([other, [a, b]]) => other !== k && a <= t && t <= b);
  };
  const showDate = w.map((wp, i) => i === 0 || formatIstDate(wp.timestamp) !== formatIstDate(w[i - 1].timestamp));
  return (
    <ol className="relative space-y-0" aria-label="Chronological camera sightings">
      {w.map((wp, i) => {
        const trip = wp.trip_index ?? 0;
        const prev = i > 0 ? w[i - 1] : null;
        const newTrip = prev != null && (prev.trip_index ?? 0) !== trip;
        const overlaps = conflicting(i); // another trip of the same plate is under way (e.g. cloned plate)
        const color = colorFor(trip);
        const active = activeIndex === i;
        const deg = headingToDegrees(wp.heading);
        return (
          <li key={`${wp.camera_id}-${wp.timestamp}-${i}`} ref={(el) => { itemRefs.current[i] = el; }}>
            {showDate[i] && (
              <div className="mb-2 mt-1 text-[10px] font-bold uppercase tracking-wider text-nero-text-muted">{formatIstDate(wp.timestamp)}</div>
            )}
            {newTrip && overlaps && wp.distance_m_from_prev == null && (
              <div className="my-2 flex items-center gap-2 pl-1 text-[10px] font-semibold text-rose-400">
                <CircleSlashIcon size={12} aria-hidden="true" />
                Same plate read elsewhere while the previous trip was still under way
              </div>
            )}
            {newTrip && !overlaps && (
              <div className="my-2 flex items-center gap-2 pl-1 text-[10px] text-nero-text-muted">
                <CircleSlashIcon size={12} aria-hidden="true" />
                Off-network for {formatDuration(wp.time_since_previous_seconds)} — new trip
              </div>
            )}
            {wp.distance_m_from_prev != null && !newTrip && (
              <div className="ml-3 flex items-center gap-2 border-l-2 py-1.5 pl-5 text-[10px] font-mono text-nero-text-secondary" style={{ borderColor: `${color}66` }}>
                <span>{formatDistance(wp.distance_m_from_prev)}</span>
                <span className="text-nero-text-muted">·</span>
                <span>{formatDuration(wp.time_since_previous_seconds)}</span>
                <span className="text-nero-text-muted">·</span>
                <span style={{ color }}>{formatSpeed(wp.speed_kmph_from_prev)}</span>
              </div>
            )}
            <button
              type="button"
              onClick={() => onSelect(i)}
              aria-current={active ? 'step' : undefined}
              className={`flex w-full items-start gap-3 rounded-xl border p-2.5 text-left transition-colors ${
                active
                  ? 'border-nero-accent/60 bg-nero-accent/10'
                  : flagged.has(i)
                    ? 'border-rose-500/40 bg-rose-500/5 hover:border-rose-400/60'
                    : 'border-nero-border bg-nero-bg/70 hover:border-nero-accent/40'
              }`}
            >
              <span
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-black text-black"
                style={{ background: color, boxShadow: active ? `0 0 12px ${color}` : undefined }}
              >
                {i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-xs font-bold text-nero-text-primary">{wp.camera_name}</span>
                  <span className="shrink-0 font-mono text-[11px] font-bold text-nero-text-primary">{formatIstTime(wp.timestamp)}</span>
                </span>
                <span className="mt-0.5 flex items-center gap-2 text-[10px] text-nero-text-muted">
                  {wp.camera_code && <span className="font-mono">{wp.camera_code}</span>}
                  {deg != null && (
                    <span className="inline-flex items-center gap-1">
                      <ArrowUpIcon size={11} style={{ transform: `rotate(${deg}deg)` }} aria-hidden="true" />
                      {headingLabel(wp.heading)}
                    </span>
                  )}
                  {overlaps && <span className="font-semibold text-rose-400">conflicting sighting</span>}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
});
