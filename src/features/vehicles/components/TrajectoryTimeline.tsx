// ═══════════════════════════════════════════════════
// TrajectoryTimeline — chronological stop log synced with the map
// ═══════════════════════════════════════════════════

import { Fragment, memo, useEffect, useRef } from 'react';
import { ArrowUpIcon, CalendarIcon, CircleSlashIcon, TriangleAlertIcon } from 'lucide-react';
import type { Trajectory } from '@/types';
import { Timeline, TimelineConnector, TimelineDivider, TimelineItem } from '@/shared/ui/Timeline';
import { useThemeTokens } from '@/shared/theme/tokens';
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
  const tokens = useThemeTokens();
  const itemRefs = useRef<(HTMLLIElement | null)[]>([]);
  const colorFor = tripColors(trajectory, tokens.series, tokens.danger);
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
    <Timeline ariaLabel="Chronological camera sightings">
      {w.map((wp, i) => {
        const trip = wp.trip_index ?? 0;
        const prev = i > 0 ? w[i - 1] : null;
        const newTrip = prev != null && (prev.trip_index ?? 0) !== trip;
        const overlaps = conflicting(i); // another trip of the same plate is under way (e.g. cloned plate)
        const color = colorFor(trip);
        const deg = headingToDegrees(wp.heading);
        return (
          <Fragment key={`${wp.camera_id}-${wp.timestamp}-${i}`}>
            {showDate[i] && <TimelineDivider icon={<CalendarIcon />}>{formatIstDate(wp.timestamp)} · IST</TimelineDivider>}
            {newTrip && overlaps && wp.distance_m_from_prev == null && (
              <TimelineDivider icon={<TriangleAlertIcon className="text-danger" />}>
                <span className="text-danger">Same plate read elsewhere during the previous trip</span>
              </TimelineDivider>
            )}
            {newTrip && !overlaps && (
              <TimelineDivider icon={<CircleSlashIcon />}>
                Off-network {formatDuration(wp.time_since_previous_seconds)} · new trip
              </TimelineDivider>
            )}
            {wp.distance_m_from_prev != null && !newTrip && (
              <TimelineConnector color={color}>
                <span>{formatDistance(wp.distance_m_from_prev)}</span>
                <span aria-hidden>·</span>
                <span>{formatDuration(wp.time_since_previous_seconds)}</span>
                <span aria-hidden>·</span>
                <span className="font-medium text-fg-muted">{formatSpeed(wp.speed_kmph_from_prev)}</span>
              </TimelineConnector>
            )}
            <TimelineItem
              itemRef={(el) => { itemRefs.current[i] = el; }}
              marker={{ label: String(i + 1), color }}
              title={wp.camera_name}
              time={formatIstTime(wp.timestamp)}
              active={activeIndex === i}
              tone={flagged.has(i) || overlaps ? 'danger' : 'default'}
              onSelect={() => onSelect(i)}
              last={i === w.length - 1}
              meta={
                <span className="flex flex-wrap items-center gap-x-2">
                  {wp.camera_code && <span className="font-mono">{wp.camera_code}</span>}
                  {deg != null && (
                    <span className="inline-flex items-center gap-1">
                      <ArrowUpIcon size={12} strokeWidth={1.75} style={{ transform: `rotate(${deg}deg)` }} aria-hidden="true" />
                      {headingLabel(wp.heading)}
                    </span>
                  )}
                  {overlaps && <span className="font-medium text-danger">Conflicting sighting</span>}
                </span>
              }
            />
          </Fragment>
        );
      })}
    </Timeline>
  );
});
