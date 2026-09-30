// ═══════════════════════════════════════════════════
// ReplayControls — "Replay the day" transport (simulated/demo mode only).
// Plays the simulated day at an accelerated clock so plate reads stream into
// the Live Map feed and watchlist / anomaly alerts fire live (toast, sidebar
// badge, Alerts queue). Shared by the Live Map and the Alerts page.
// ═══════════════════════════════════════════════════

import { FastForwardIcon, PauseIcon, PlayIcon, SquareIcon } from 'lucide-react';
import { isSupabaseConfigured } from '@/lib/supabase/client';
import { Button, IconButton } from '@/shared/ui/Button';
import { Select } from '@/shared/ui/Input';
import { cn } from '@/shared/lib/cn';
import { usePrefersReducedMotion } from '@/features/vehicles/hooks/usePrefersReducedMotion';
import {
  REPLAY_SPEEDS,
  dayEnd,
  dayStart,
  formatReplayClock,
  pauseReplay,
  resumeReplay,
  seekReplay,
  setReplaySpeed,
  startReplay,
  stopReplay,
  useReplay,
  type ReplaySpeed,
} from './clock';

export function ReplayControls({ className, compact = false }: { className?: string; compact?: boolean }) {
  const replay = useReplay();
  const reduced = usePrefersReducedMotion();
  if (isSupabaseConfigured()) return null;

  if (!replay.active) {
    return (
      <Button
        size="sm"
        variant="secondary"
        icon={<PlayIcon size={14} />}
        onClick={() => startReplay()}
        className={className}
        title="Replay the simulated day from 07:58 IST at 60× — plate reads stream in and watchlist / anomaly alerts fire live"
      >
        Replay the day
      </Button>
    );
  }

  const ended = replay.clock >= dayEnd();
  return (
    <div
      role="group"
      aria-label="Replay the day"
      className={cn('flex min-w-0 flex-wrap items-center gap-1.5 rounded-sm border border-line bg-surface px-1.5 py-1 sm:flex-nowrap', className)}
    >
      <IconButton
        size="sm"
        variant="ghost"
        label={replay.playing ? 'Pause replay' : ended ? 'Replay ended' : 'Resume replay'}
        icon={replay.playing ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
        onClick={() => (replay.playing ? pauseReplay() : resumeReplay())}
        disabled={ended}
      />
      <span className="flex items-center gap-1.5 pr-1" aria-live="off">
        <span
          aria-hidden
          className={cn('h-1.5 w-1.5 rounded-full', replay.playing ? 'bg-danger' : 'bg-fg-subtle', replay.playing && !reduced && 'animate-live-pulse')}
        />
        <span className="font-mono text-xs font-semibold tabular-nums text-fg">{formatReplayClock(replay.clock)}</span>
        <span className="text-2xs text-fg-subtle">IST · replay</span>
      </span>
      {!compact && (
        <input
          type="range"
          aria-label="Replay time"
          min={dayStart()}
          max={dayEnd()}
          step={60_000}
          value={replay.clock}
          onChange={(e) => seekReplay(Number(e.target.value))}
          className="hidden w-28 accent-[var(--primary)] lg:block"
        />
      )}
      <Select
        uiSize="sm"
        aria-label="Replay speed"
        icon={<FastForwardIcon />}
        value={String(replay.speed)}
        onChange={(e) => setReplaySpeed(Number(e.target.value) as ReplaySpeed)}
      >
        {REPLAY_SPEEDS.map((s) => (
          <option key={s} value={s}>{`${s}×`}</option>
        ))}
      </Select>
      <IconButton size="sm" variant="ghost" label="Stop replay (show the whole day)" icon={<SquareIcon size={12} />} onClick={stopReplay} />
    </div>
  );
}
