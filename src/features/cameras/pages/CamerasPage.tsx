// ═══════════════════════════════════════════════════
// CamerasPage — video wall, selected (streaming) feed and AI detection rail.
// Selection lives in the URL (?cam=CODE); it defaults to the first online
// camera in the current zone. Only the primary feed streams — wall tiles are
// posters, so only one clip streams at a time.
// ═══════════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  CameraIcon, CctvIcon, FilterIcon, Grid2x2Icon, Grid3x3Icon, LayoutGridIcon, MapPinIcon, Maximize2Icon,
} from 'lucide-react';
import type { Camera } from '@/types/camera';
import type { Detection } from '@/types';
import { useCameras } from '@/features/cameras/hooks/useCameras';
import { CameraVideoPlayer, type FeedStatus } from '@/features/cameras/components/CameraVideoPlayer';
import { WallTile } from '@/features/cameras/components/WallTile';
import { CameraAiPanel } from '@/features/cameras/components/CameraAiPanel';
import { pickCamera } from '@/features/cameras/lib/pickCamera';
import { composeSnapshot, downloadDataUrl, snapshotFilename } from '@/features/cameras/lib/snapshot';
import { Page, PageHeader } from '@/shared/layout/Page';
import { Badge } from '@/shared/ui/Badge';
import { IconButton } from '@/shared/ui/Button';
import { Select } from '@/shared/ui/Input';
import { Tabs } from '@/shared/ui/Tabs';
import { EmptyState } from '@/shared/ui/EmptyState';
import { ErrorState } from '@/shared/ui/ErrorState';
import { Skeleton, SkeletonPanel } from '@/shared/ui/Skeleton';
import { toast } from '@/shared/ui/toast';

type Density = '2' | '3' | '4';
const DENSITY_KEY = 'nero.cameras.wall';
const WALL_COLS: Record<Density, string> = {
  '2': 'grid-cols-1 min-[480px]:grid-cols-2',
  '3': 'grid-cols-1 min-[480px]:grid-cols-2 md:grid-cols-3',
  '4': 'grid-cols-1 min-[480px]:grid-cols-2 md:grid-cols-3 2xl:grid-cols-4',
};

function readDensity(): Density {
  try {
    const v = localStorage.getItem(DENSITY_KEY);
    if (v === '2' || v === '3' || v === '4') return v;
  } catch {
    /* storage unavailable */
  }
  return '3';
}

export function CamerasPage() {
  const { cameras, loading, error, refetch } = useCameras();
  const [params, setParams] = useSearchParams();
  const [selectedZone, setSelectedZone] = useState<string>('all');
  const [density, setDensity] = useState<Density>(readDensity);

  const zones = ['all', ...new Set(cameras.map((c) => c.zone))];
  const filtered = selectedZone === 'all' ? cameras : cameras.filter((c) => c.zone === selectedZone);
  const selected = pickCamera(filtered, params.get('cam'));
  const online = cameras.filter((c) => c.status === 'online').length;
  const offline = cameras.length - online;

  const select = (cam: Camera) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('cam', cam.code);
        return next;
      },
      { replace: true },
    );

  const changeDensity = (id: string) => {
    const d = id as Density;
    setDensity(d);
    try {
      localStorage.setItem(DENSITY_KEY, d);
    } catch {
      /* storage unavailable */
    }
  };

  const header = (
    <PageHeader
      title="Camera Network"
      description="Live ANPR feeds with on-frame YOLOv7 detections"
      icon={CctvIcon}
      meta={
        !loading && !error && cameras.length > 0 ? (
          <>
            <Badge tone="success" size="sm" className="tabular-nums">{`${online} online`}</Badge>
            <Badge tone={offline > 0 ? 'danger' : 'neutral'} size="sm" className="tabular-nums">{`${offline} offline`}</Badge>
          </>
        ) : undefined
      }
      actions={
        cameras.length > 0 ? (
          <>
            <Select aria-label="Zone" label="Zone" icon={<FilterIcon size={14} strokeWidth={1.75} />} value={selectedZone} onChange={(e) => setSelectedZone(e.target.value)}>
              {zones.map((zone) => (
                <option key={zone} value={zone}>{zone === 'all' ? 'All zones' : zone}</option>
              ))}
            </Select>
            <Tabs
              ariaLabel="Video wall density"
              variant="segmented"
              size="sm"
              value={density}
              onChange={changeDensity}
              items={[
                { id: '2', label: '2×2', icon: <Grid2x2Icon size={14} strokeWidth={1.75} /> },
                { id: '3', label: '3×3', icon: <Grid3x3Icon size={14} strokeWidth={1.75} /> },
                { id: '4', label: '4×4', icon: <LayoutGridIcon size={14} strokeWidth={1.75} /> },
              ]}
            />
          </>
        ) : undefined
      }
    />
  );

  if (loading) {
    return (
      <Page>
        {header}
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]" aria-busy="true" aria-label="Loading cameras">
          <div className="space-y-4">
            <SkeletonPanel height="clamp(240px, 40vw, 520px)" />
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="aspect-video w-full" />)}
            </div>
          </div>
          <SkeletonPanel height={420} />
        </div>
      </Page>
    );
  }
  if (error) {
    return (
      <Page>
        {header}
        <ErrorState title="Cameras unavailable" message={error} onRetry={refetch} />
      </Page>
    );
  }
  if (cameras.length === 0) {
    return (
      <Page>
        {header}
        <EmptyState
          icon={<CctvIcon size={20} />}
          title="No cameras found"
          description="Check your Supabase connection or seed the cameras table."
        />
      </Page>
    );
  }

  const wall = (
    <section aria-label="Video wall" className="space-y-2">
      <h2 className="text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">
        Video wall · <span className="tabular-nums">{filtered.length}</span> cameras
      </h2>
      <div className={`grid gap-3 ${WALL_COLS[density]}`}>
        {filtered.map((camera) => (
          <WallTile key={camera.id} camera={camera} selected={selected?.id === camera.id} onSelect={() => select(camera)} />
        ))}
      </div>
    </section>
  );

  return (
    <Page>
      {header}
      {selected ? (
        // Keyed by camera: switching tears down the old stream, aborts its
        // detection request and resets the AI rail in one go.
        <CameraWorkspace key={selected.id} camera={selected} wall={wall} />
      ) : (
        wall
      )}
    </Page>
  );
}

function CameraWorkspace({ camera, wall }: { camera: Camera; wall: ReactNode }) {
  const navigate = useNavigate();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const mediaRef = useRef<HTMLDivElement | null>(null);
  const [feedStatus, setFeedStatus] = useState<FeedStatus>('connecting');
  const [detections, setDetections] = useState<Detection[]>([]);
  const [resolution, setResolution] = useState<string | null>(null);
  const [lastFrameAt, setLastFrameAt] = useState<number | null>(null);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);

  const onVideoElement = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    setVideo(el);
  }, []);

  // Stream resolution + last-frame time (throttled to 1 Hz).
  useEffect(() => {
    if (!video) return;
    const meta = () => {
      if (video.videoWidth) setResolution(`${video.videoWidth}×${video.videoHeight}`);
    };
    let last = 0;
    const tick = () => {
      const now = Date.now();
      if (now - last >= 1000) {
        last = now;
        setLastFrameAt(now);
      }
    };
    meta();
    video.addEventListener('loadedmetadata', meta);
    video.addEventListener('timeupdate', tick);
    return () => {
      video.removeEventListener('loadedmetadata', meta);
      video.removeEventListener('timeupdate', tick);
    };
  }, [video]);

  const fullscreen = () => {
    const frame = (mediaRef.current?.closest('[data-status]') as HTMLElement | null) ?? mediaRef.current;
    frame?.requestFullscreen?.().catch(() => toast({ tone: 'warning', title: 'Fullscreen is not available' }));
  };

  const snapshot = () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      const url = composeSnapshot(v, mediaRef.current?.querySelector('canvas'));
      downloadDataUrl(url, snapshotFilename(camera.code));
      toast({ tone: 'success', title: 'Snapshot saved', description: `${camera.code} frame downloaded as PNG` });
    } catch (e) {
      toast({ tone: 'danger', title: 'Snapshot failed', description: e instanceof Error ? e.message : undefined });
    }
  };

  const playing = feedStatus === 'playing';

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
      <div className="min-w-0 space-y-4">
        <section aria-label="Primary feed" className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <h2 className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-fg">
                <span className="truncate">{camera.name}</span>
                <span className="font-mono text-xs font-medium text-fg-muted">{camera.code}</span>
              </h2>
              <p className="flex flex-wrap items-center gap-x-2 text-xs text-fg-muted">
                <span>{camera.zone}</span>
                <span className="text-fg-subtle" aria-hidden="true">·</span>
                <span>{camera.direction}</span>
                {camera.road && (
                  <>
                    <span className="text-fg-subtle" aria-hidden="true">·</span>
                    <span className="truncate">{camera.road}</span>
                  </>
                )}
              </p>
            </div>
            <div className="flex items-center gap-1">
              <IconButton label="Fullscreen" icon={<Maximize2Icon size={16} strokeWidth={1.75} />} onClick={fullscreen} disabled={feedStatus === 'offline'} />
              <IconButton label="Snapshot" icon={<CameraIcon size={16} strokeWidth={1.75} />} onClick={snapshot} disabled={!playing} />
              <IconButton label="Open on map" icon={<MapPinIcon size={16} strokeWidth={1.75} />} onClick={() => navigate(`/?cam=${encodeURIComponent(camera.code)}`)} />
            </div>
          </div>
          <CameraVideoPlayer
            camera={camera}
            mediaRef={mediaRef}
            onVideoElement={onVideoElement}
            onStatusChange={setFeedStatus}
            onDetections={setDetections}
          />
        </section>
        {wall}
      </div>

      <CameraAiPanel
        camera={camera}
        videoRef={videoRef}
        feedStatus={feedStatus}
        detections={detections}
        resolution={resolution}
        lastFrameAt={lastFrameAt}
      />
    </div>
  );
}
