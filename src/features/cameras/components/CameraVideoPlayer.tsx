// ═══════════════════════════════════════════════════
// CameraVideoPlayer Component
// Pure CCTV Video Feed with robust CORS & Supabase Storage video playback
//
// Clips are the Mumbai renditions (local dev copy or the private Supabase
// Storage bucket, see VITE_VIDEO_SOURCE): 720p for wall tiles, and 1080p (HD)
// for the selected feed when it exists, with a silent fall back to 720p. Storage clips play from 1-hour signed
// URLs (../lib/signedMedia.ts) that are refreshed before they expire; the swap
// re-syncs to the live clock, so the feed never restarts. A failing signed URL
// is re-signed once; then the other source is tried once before the tile goes
// "Feed offline".
// Bandwidth rules:
// - nothing but metadata is requested until the player is on screen
// - it only plays while visible (IntersectionObserver) and the tab is shown,
//   and pauses as soon as it scrolls away
// - detections are only fetched once the player has been visible
// - a broken feed shows an explicit "Feed offline" state instead of a black tile
// Live clock: playback position follows the camera's virtual live clock
// (../lib/liveClock.ts) — on load, on resume, when the tab comes back, after
// the loop point and whenever it drifts — so a feed never restarts at 0.
// `crossOrigin="anonymous"` + `muted playsInline` are required for autoplay
// and for canvas frame capture — keep them.
// ═══════════════════════════════════════════════════

import { useRef, useEffect, useState, type ReactNode, type RefObject } from 'react';
import { ScanLineIcon } from 'lucide-react';
import type { Camera } from '@/types/camera';
import type { Detection } from '@/types';
import { useDetectionOverlay } from '@/features/detections/hooks/useDetectionOverlay';
import { useCameraDetections } from '@/features/detections/hooks/useCameraDetections';
import { resolveCameraMedia } from '@/features/cameras/api';
import { invalidateSignedMedia, useSignedMediaUrl } from '@/features/cameras/lib/signedMedia';
import { useInViewport } from '@/features/cameras/hooks/useInViewport';
import { fetchCameraEvents } from '@/features/detections/api';
import { LIVE_DRIFT_TOLERANCE_SEC, syncVideoToLiveClock } from '@/features/cameras/lib/liveClock';
import { VIDEO_OVERLAY } from '@/shared/theme/tokens';
import { VideoTile } from '@/shared/ui/VideoTile';

export type FeedStatus = 'connecting' | 'playing' | 'offline';

interface CameraVideoPlayerProps {
  camera: Camera;
  detections?: Detection[];
  /** Receives the current <video> element (null when torn down / offline). Used by the snapshot button and camera health. */
  onVideoElement?: (el: HTMLVideoElement | null) => void;
  /** The pipeline detections loaded for this clip (shared so callers need not refetch). */
  onDetections?: (detections: Detection[]) => void;
  /** Feed state changes (connecting → playing → offline). */
  onStatusChange?: (status: FeedStatus) => void;
  /** Attached to the media layer (video + overlay canvas) — for fullscreen / snapshot. */
  mediaRef?: RefObject<HTMLDivElement | null>;
  /** Extra chips in the frame's top-right corner. */
  topRight?: ReactNode;
  /** 'primary' = the large selected feed; 'tile' = a video-wall tile (plate labels only). */
  variant?: 'primary' | 'tile';
  /** Tile only: selection state / handler / caption. */
  selected?: boolean;
  onSelect?: () => void;
  footer?: ReactNode;
  /** Watchlisted plates (plateKey form) — drawn in red on the overlay. */
  watchlist?: ReadonlySet<string>;
  className?: string;
}

export function CameraVideoPlayer(props: CameraVideoPlayerProps) {
  // "Retry" remounts the whole player so video element, overlay and state start fresh.
  const [attempt, setAttempt] = useState(0);
  return <PlayerInner key={attempt} {...props} onRetry={() => setAttempt((n) => n + 1)} />;
}

function PlayerInner({
  camera,
  detections: propDetections,
  onRetry,
  onVideoElement,
  onStatusChange,
  onDetections,
  mediaRef,
  topRight,
  variant = 'primary',
  selected,
  onSelect,
  footer,
  watchlist,
  className,
}: CameraVideoPlayerProps & { onRetry: () => void }) {
  const tile = variant === 'tile';
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const inView = useInViewport(containerRef);
  const [hasBeenVisible, setHasBeenVisible] = useState(false);
  const [status, setStatus] = useState<FeedStatus>('connecting');
  const usedFallbackRef = useRef(false);
  const resignedRef = useRef(false);

  if (inView && !hasBeenVisible) setHasBeenVisible(true);

  const media = resolveCameraMedia(camera.video_url, camera.code, camera.id);
  const fallbackSrc = media.fallback;
  const clipFile = media.video.split('?')[0].split('/').pop();
  // Private bucket → signed URL (undefined while signing, null if it failed).
  const signedVideo = useSignedMediaUrl(media.video);
  // The selected (main) feed plays the 1080p rendition when there is one: plates are unreadable at
  // 720p, and the live ANPR frames are grabbed from this element. Wall tiles stay on 720p (8 clips
  // play at once). A missing/unsignable/undecodable HD file silently drops back to the 720p clip.
  const wantHd = !tile && !!media.hd;
  const signedHd = useSignedMediaUrl(wantHd ? media.hd : undefined);
  const [hdFailed, setHdFailed] = useState(false);
  const hdResignedRef = useRef(false);
  // Latch: once signing says the HD object is unavailable, never swap sources again when signing is retried.
  if (wantHd && signedHd === null && !hdFailed) setHdFailed(true);
  const hdActive = wantHd && !hdFailed && signedHd !== null;
  const videoSrc = hdActive ? signedHd || undefined : signedVideo === null ? fallbackSrc || undefined : signedVideo;
  const poster = useSignedMediaUrl(camera.poster_url || media.poster || undefined) || undefined;

  // Fetch real pipeline detections only once the feed is actually on screen.
  const hasPropDetections = !!propDetections && propDetections.length > 0;
  const { detections: realDetections } = useCameraDetections(camera.code, camera.id, {
    enabled: hasBeenVisible && !hasPropDetections,
  });
  const activeDetections = hasPropDetections ? propDetections! : realDetections;

  // Sync bounding box canvas overlay with video timeline
  const { activeDetections: inFrame } = useDetectionOverlay(videoRef, canvasRef, activeDetections, {
    variant: tile ? 'tile' : 'full',
    watchlist,
  });

  // Canonical clip length for the live clock (events file) — shared with the
  // overlay and the live plate-read list so all three loop together.
  const clockDurRef = useRef<number | null>(null);
  useEffect(() => {
    if (!hasBeenVisible) return;
    let active = true;
    fetchCameraEvents(camera.code).then((doc) => {
      if (!active || !doc?.duration_sec) return;
      clockDurRef.current = doc.duration_sec;
      const v = videoRef.current;
      if (v) syncVideoToLiveClock(v, camera.code, 0.25, Date.now(), doc.duration_sec);
    });
    return () => {
      active = false;
    };
  }, [camera.code, hasBeenVisible]);

  // Keep playback on the live clock: after metadata, after the loop point and
  // whenever buffering / throttling makes it drift.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || status === 'offline') return;
    const snap = () => syncVideoToLiveClock(video, camera.code, 0.25, Date.now(), clockDurRef.current);
    const drift = () => {
      if (!video.paused && !video.seeking) syncVideoToLiveClock(video, camera.code, LIVE_DRIFT_TOLERANCE_SEC, Date.now(), clockDurRef.current);
    };
    video.addEventListener('loadedmetadata', snap);
    video.addEventListener('ended', snap);
    video.addEventListener('timeupdate', drift);
    snap();
    return () => {
      video.removeEventListener('loadedmetadata', snap);
      video.removeEventListener('ended', snap);
      video.removeEventListener('timeupdate', drift);
    };
  }, [camera.code, status, videoSrc]);

  // Report status / element to the caller (AI detection panel, snapshot).
  const statusCb = useRef(onStatusChange);
  const elementCb = useRef(onVideoElement);
  const detectionsCb = useRef(onDetections);
  useEffect(() => {
    statusCb.current = onStatusChange;
    elementCb.current = onVideoElement;
    detectionsCb.current = onDetections;
  });
  useEffect(() => {
    detectionsCb.current?.(activeDetections);
  }, [activeDetections]);
  useEffect(() => {
    statusCb.current?.(status);
  }, [status]);
  useEffect(() => {
    const cb = elementCb.current;
    cb?.(status === 'offline' ? null : videoRef.current);
    return () => cb?.(null);
  }, [status]);

  // Play while visible and the tab is foregrounded; pause otherwise.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || status === 'offline') return;

    const sync = () => {
      const shouldPlay = inView && document.visibilityState !== 'hidden';
      if (shouldPlay) {
        video.muted = true;
        if (video.preload !== 'auto') video.preload = 'auto';
        // Resume where the "live" camera is now, not where it was paused.
        syncVideoToLiveClock(video, camera.code, 0.25, Date.now(), clockDurRef.current);
        const p = video.play();
        if (p && typeof p.catch === 'function') {
          p.catch((err: unknown) => {
            if ((err as { name?: string })?.name !== 'AbortError') {
              console.warn('Autoplay prevented or video play error:', err);
            }
          });
        }
      } else if (!video.paused) {
        video.pause();
      }
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, [inView, videoSrc, status, camera.code]);

  const handleError = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const target = e.currentTarget;
    if (hdActive) {
      // HD is optional: re-sign an expired URL once, then use the 720p clip. Never an "offline" state.
      if (!hdResignedRef.current && target.src === signedHd && invalidateSignedMedia(media.hd)) {
        hdResignedRef.current = true;
        return;
      }
      setHdFailed(true);
      return;
    }
    // An expired / revoked signed URL: sign it again once (new src re-renders).
    if (!resignedRef.current && target.src === signedVideo && invalidateSignedMedia(media.video)) {
      resignedRef.current = true;
      return;
    }
    if (!usedFallbackRef.current && fallbackSrc && target.currentSrc !== fallbackSrc && target.src !== fallbackSrc) {
      usedFallbackRef.current = true;
      console.warn(`Video load error for camera ${camera.code}; trying the other video source.`);
      target.src = fallbackSrc;
      target.load();
      return;
    }
    setStatus('offline');
  };

  const tileStatus = status === 'offline' ? 'offline' : status === 'playing' ? 'live' : inView ? 'connecting' : 'paused';
  const setMediaEl = (el: HTMLDivElement | null) => {
    containerRef.current = el;
    if (mediaRef) mediaRef.current = el;
  };

  return (
    <VideoTile
      size={tile ? 'sm' : 'lg'}
      code={camera.code}
      name={camera.name}
      zone={camera.zone}
      status={tileStatus}
      onRetry={onRetry}
      offlineDetail={`Clip ${clipFile} could not be loaded from either video source`}
      clock={!tile && status === 'playing'}
      selected={selected}
      onSelect={onSelect}
      footer={footer}
      topRight={
        <>
          {!tile && status === 'playing' && inFrame.length > 0 && (
            <span
              className="inline-flex h-5 items-center gap-1 rounded-sm px-1.5 text-2xs font-semibold tabular-nums"
              style={{ background: 'var(--overlay-bg)', color: 'var(--overlay-fg)' }}
              title="Vehicles detected in the current frame"
            >
              <ScanLineIcon size={12} strokeWidth={1.75} aria-hidden="true" />
              {inFrame.length} in frame
            </span>
          )}
          {topRight}
        </>
      }
      className={className}
    >
      <div ref={setMediaEl} className="absolute inset-0" style={{ background: VIDEO_OVERLAY.frameBg }}>
        {status !== 'offline' && (
          <video
            ref={videoRef}
            src={videoSrc}
            data-quality={hdActive ? 'hd' : 'sd'}
            poster={poster}
            // Nothing until first visible, then metadata; upgraded to 'auto' when it starts playing.
            preload={hasBeenVisible ? 'metadata' : 'none'}
            loop
            muted
            playsInline
            controls={false}
            crossOrigin="anonymous"
            onPlaying={() => setStatus('playing')}
            onError={handleError}
            className="pointer-events-none h-full w-full select-none object-contain"
          />
        )}

        {/* Detection overlay canvas */}
        <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 z-10 h-full w-full" />
      </div>
    </VideoTile>
  );
}
