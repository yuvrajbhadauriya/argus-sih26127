// Video-wall tile. Wall tiles never stream (the source clips are 4K at
// 16–20 Mbps each) — they show a poster if the camera has one, otherwise a
// neutral frame. Selecting a tile moves it into the primary feed.
import { CctvIcon } from 'lucide-react';
import type { Camera } from '@/types/camera';
import { VideoTile } from '@/shared/ui/VideoTile';

interface WallTileProps {
  camera: Camera;
  selected: boolean;
  onSelect: () => void;
}

export function WallTile({ camera, selected, onSelect }: WallTileProps) {
  // `thumbnail_url` exists on the mock feed shape but not on `Camera`; use it when present.
  const poster = (camera as Camera & { thumbnail_url?: string }).thumbnail_url;
  const offline = camera.status === 'offline';

  return (
    <VideoTile
      size="sm"
      code={camera.code}
      name={camera.name}
      zone={camera.zone}
      status={offline ? 'offline' : selected ? 'live' : 'paused'}
      selected={selected}
      onSelect={onSelect}
      footer={
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{camera.zone}</span>
          <span className="text-fg-subtle" aria-hidden="true">·</span>
          <span className="shrink-0">{camera.direction}</span>
        </span>
      }
    >
      {poster ? (
        <img src={poster} alt="" loading="lazy" className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1.5" style={{ color: 'var(--overlay-fg)' }}>
          <CctvIcon size={22} strokeWidth={1.5} aria-hidden="true" className="opacity-50" />
          <span className="text-2xs opacity-60">{selected ? 'In primary view' : 'Select to view feed'}</span>
        </div>
      )}
    </VideoTile>
  );
}
