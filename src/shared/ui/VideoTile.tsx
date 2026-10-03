// ═══════════════════════════════════════════════════
// VideoTile — chrome around a camera frame (the media layer is children).
// Video is always dark, so the frame uses fixed overlay colours in both themes.
// ═══════════════════════════════════════════════════

import type { ReactNode } from 'react';
import { LoaderCircleIcon, RotateCcwIcon, VideoOffIcon } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { VIDEO_OVERLAY } from '@/shared/theme/tokens';
import { LiveClock } from '@/shared/layout/LiveClock';
import { Button } from './Button';

export type VideoTileStatus = 'live' | 'connecting' | 'paused' | 'offline';

export interface VideoTileProps {
  code: string;
  name: string;
  zone?: string;
  status: VideoTileStatus;
  selected?: boolean;
  onSelect?: () => void;
  onRetry?: () => void;
  /** Second line of the offline state (default: "<code> stream unavailable"). */
  offlineDetail?: string;
  clock?: boolean;
  topRight?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'lg';
  children?: ReactNode;
  className?: string;
}

const CHIP = 'inline-flex h-5 items-center gap-1.5 rounded-sm px-1.5 text-2xs leading-none';
const chipStyle = { backgroundColor: 'var(--overlay-bg)', color: 'var(--overlay-fg)' };

function StatusChip({ status }: { status: VideoTileStatus }) {
  if (status === 'offline') return null;
  return (
    <span className={CHIP} style={chipStyle} data-status={status}>
      {status === 'live' && <span aria-hidden className="h-1.5 w-1.5 rounded-full animate-live-pulse" style={{ backgroundColor: VIDEO_OVERLAY.liveDot }} />}
      {status === 'connecting' && <LoaderCircleIcon size={10} className="animate-spin" aria-hidden />}
      <span className="text-[10px] font-bold tracking-[0.06em]">
        {status === 'live' ? 'LIVE' : status === 'connecting' ? 'CONNECTING' : 'PAUSED'}
      </span>
    </span>
  );
}

export function VideoTile({
  code,
  name,
  zone,
  status,
  selected = false,
  onSelect,
  onRetry,
  offlineDetail,
  clock = false,
  topRight,
  footer,
  size = 'sm',
  children,
  className,
}: VideoTileProps) {
  const frame = (
    <div
      className={cn(
        'relative aspect-video w-full overflow-hidden rounded-md border',
        selected ? 'border-primary ring-2 ring-primary' : 'border-line',
      )}
      style={{ backgroundColor: VIDEO_OVERLAY.frameBg }}
      data-status={status}
    >
      {status !== 'offline' && <div className="absolute inset-0 [&>*]:h-full [&>*]:w-full">{children}</div>}

      {onSelect && (
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={selected}
          aria-label={`Open feed ${code} ${name}`}
          className="absolute inset-0 z-[1] cursor-pointer rounded-md transition-colors hover:bg-white/5 focus-visible:-outline-offset-2"
        />
      )}

      {status === 'offline' && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 bg-surface-2 px-3 text-center">
          <VideoOffIcon size={24} className="text-danger" aria-hidden />
          <p className="mt-1 text-[13px] font-semibold text-fg">Feed offline</p>
          <p className="text-xs text-fg-muted">{offlineDetail ?? `${code} stream unavailable`}</p>
          {onRetry && (
            <Button
              size="sm"
              className="pointer-events-auto relative z-[2] mt-2"
              icon={<RotateCcwIcon size={14} />}
              onClick={(e) => {
                e.stopPropagation();
                onRetry();
              }}
            >
              Retry
            </Button>
          )}
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-0 top-0 z-[2] flex items-start justify-between gap-2 p-2">
        <span className={cn(CHIP, 'min-w-0 max-w-[75%]')} style={chipStyle}>
          <span className="shrink-0 whitespace-nowrap font-mono text-2xs font-semibold">{code}</span>
          <span className={cn('min-w-0 truncate opacity-85', size === 'sm' && 'max-w-[10rem] max-sm:hidden')}>{name}</span>
          {zone && size === 'lg' && <span className="truncate opacity-70">· {zone}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {topRight}
          <StatusChip status={status} />
        </span>
      </div>

      {clock && status !== 'offline' && (
        <span className={cn(CHIP, 'pointer-events-none absolute bottom-2 right-2 z-[2] font-mono tabular-nums')} style={chipStyle}>
          <LiveClock /> IST
        </span>
      )}
    </div>
  );

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {frame}
      {footer && <div className="min-w-0 text-xs text-fg-muted">{footer}</div>}
    </div>
  );
}
