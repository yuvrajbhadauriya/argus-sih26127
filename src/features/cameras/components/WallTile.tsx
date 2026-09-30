// Video-wall tile. On a desktop connection each on-screen tile streams its
// clip on the camera's live clock with plate labels drawn over it (players
// only load / play while visible). On phones, data-saver connections, and for
// the camera already in the primary view, the tile shows the clip's poster
// frame instead. Selecting a tile moves it into the primary feed.
import { useState } from 'react';
import { CctvIcon } from 'lucide-react';
import type { Camera } from '@/types/camera';
import { VideoTile } from '@/shared/ui/VideoTile';
import { CameraVideoPlayer } from './CameraVideoPlayer';
import { useSignedMediaUrl } from '../lib/signedMedia';

interface WallTileProps {
  camera: Camera;
  selected: boolean;
  onSelect: () => void;
  /** Stream the clip (see canStreamWall) instead of showing the poster. */
  live?: boolean;
  watchlist?: ReadonlySet<string>;
}

export function WallTile({ camera, selected, onSelect, live = false, watchlist }: WallTileProps) {
  const [posterFailed, setPosterFailed] = useState(false);
  const signedPoster = useSignedMediaUrl(camera.poster_url) || undefined;
  const poster = posterFailed ? undefined : signedPoster;
  const offline = camera.status === 'offline';

  const footer = (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate">{camera.zone}</span>
      <span className="text-fg-subtle" aria-hidden="true">·</span>
      <span className="shrink-0">{camera.direction}</span>
    </span>
  );

  if (live && !selected && !offline) {
    return <CameraVideoPlayer camera={camera} variant="tile" selected={false} onSelect={onSelect} footer={footer} watchlist={watchlist} />;
  }

  return (
    <VideoTile
      size="sm"
      code={camera.code}
      name={camera.name}
      zone={camera.zone}
      status={offline ? 'offline' : selected ? 'live' : 'paused'}
      selected={selected}
      onSelect={onSelect}
      footer={footer}
    >
      {poster ? (
        <img src={poster} alt="" loading="lazy" onError={() => setPosterFailed(true)} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1.5" style={{ color: 'var(--overlay-fg)' }}>
          <CctvIcon size={22} strokeWidth={1.5} aria-hidden="true" className="opacity-50" />
          <span className="text-2xs opacity-60">{selected ? 'In primary view' : 'Select to view feed'}</span>
        </div>
      )}
    </VideoTile>
  );
}
