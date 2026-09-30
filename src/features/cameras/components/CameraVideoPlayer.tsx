// ═══════════════════════════════════════════════════
// CameraVideoPlayer Component
// Pure CCTV Video Feed with robust CORS & Supabase Storage video playback
//
// Bandwidth rules (the source clips are 4K/30fps, ~16–20 Mbps each):
// - nothing but metadata is requested until the player is on screen
// - it only plays while visible (IntersectionObserver) and the tab is shown,
//   and pauses as soon as it scrolls away
// - detections are only fetched once the player has been visible
// - a broken feed shows an explicit "Feed offline" state instead of a black tile
// `crossOrigin="anonymous"` + `muted playsInline` are required for autoplay
// and for canvas frame capture — keep them.
// ═══════════════════════════════════════════════════

import { useRef, useEffect, useState } from 'react';
import { VideoOffIcon, RotateCcwIcon } from 'lucide-react';
import type { Camera } from '@/types/camera';
import type { Detection } from '@/types';
import { useDetectionOverlay } from '@/features/detections/hooks/useDetectionOverlay';
import { useCameraDetections } from '@/features/detections/hooks/useCameraDetections';
import { resolveSupabaseVideoUrl } from '@/features/cameras/api';
import { useInViewport } from '@/features/cameras/hooks/useInViewport';
import { LiveDetectPanel } from '@/features/detections/components/LiveDetectPanel';

interface CameraVideoPlayerProps {
  camera: Camera;
  detections?: Detection[];
}

type FeedStatus = 'connecting' | 'playing' | 'offline';

export function CameraVideoPlayer(props: CameraVideoPlayerProps) {
  // "Retry" remounts the whole player so video element, overlay and state start fresh.
  const [attempt, setAttempt] = useState(0);
  return <PlayerInner key={attempt} {...props} onRetry={() => setAttempt((n) => n + 1)} />;
}

function PlayerInner({
  camera,
  detections: propDetections,
  onRetry,
}: CameraVideoPlayerProps & { onRetry: () => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const inView = useInViewport(containerRef);
  const [hasBeenVisible, setHasBeenVisible] = useState(false);
  const [status, setStatus] = useState<FeedStatus>('connecting');
  const usedFallbackRef = useRef(false);

  if (inView && !hasBeenVisible) setHasBeenVisible(true);

  const videoSrc = resolveSupabaseVideoUrl(camera.video_url, camera.code, camera.id);
  const fallbackSrc = resolveSupabaseVideoUrl('', camera.code, camera.id);

  // Fetch real pipeline detections only once the feed is actually on screen.
  const hasPropDetections = !!propDetections && propDetections.length > 0;
  const { detections: realDetections } = useCameraDetections(camera.code, camera.id, {
    enabled: hasBeenVisible && !hasPropDetections,
  });
  const activeDetections = hasPropDetections ? propDetections! : realDetections;

  // Sync green bounding box canvas overlay with video timeline
  useDetectionOverlay(videoRef, canvasRef, activeDetections);

  // Play while visible and the tab is foregrounded; pause otherwise.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || status === 'offline') return;

    const sync = () => {
      const shouldPlay = inView && document.visibilityState !== 'hidden';
      if (shouldPlay) {
        video.muted = true;
        if (video.preload !== 'auto') video.preload = 'auto';
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
  }, [inView, videoSrc, status]);

  const handleError = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const target = e.currentTarget;
    if (!usedFallbackRef.current && fallbackSrc && target.currentSrc !== fallbackSrc && target.src !== fallbackSrc) {
      usedFallbackRef.current = true;
      console.warn(`Video load error for camera ${camera.code}. Falling back to unique Supabase video URL.`);
      target.src = fallbackSrc;
      target.load();
      return;
    }
    setStatus('offline');
  };

  return (
    <div ref={containerRef} className="w-full h-full flex flex-col items-center justify-center">
      {/* Video Container — Fullscreen video without controls, looping */}
      <div className="relative w-full aspect-video overflow-hidden rounded-xl bg-black flex items-center justify-center shadow-2xl">
        {status !== 'offline' && (
          <video
            ref={videoRef}
            src={videoSrc}
            // Nothing until first visible, then metadata; upgraded to 'auto' when it starts playing.
            preload={hasBeenVisible ? 'metadata' : 'none'}
            loop
            muted
            playsInline
            controls={false}
            crossOrigin="anonymous"
            onPlaying={() => setStatus('playing')}
            onError={handleError}
            className="w-full h-full object-contain pointer-events-none select-none"
          />
        )}

        {status === 'connecting' && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 text-nero-text-muted pointer-events-none">
            <div className="relative h-8 w-8">
              <div className="absolute inset-0 rounded-full border-2 border-nero-border" />
              <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-nero-accent" />
            </div>
            <p className="text-xs">{inView ? 'Connecting to feed…' : 'Feed paused (off screen)'}</p>
          </div>
        )}

        {status === 'offline' && (
          <div role="status" className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-nero-surface text-nero-text-muted">
            <VideoOffIcon size={28} className="text-rose-400" />
            <p className="text-sm font-semibold text-nero-text-primary">Feed offline</p>
            <p className="text-[11px]">{camera.code} video stream could not be loaded</p>
            <button
              type="button"
              onClick={onRetry}
              className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-nero-border px-3 py-1 text-xs font-medium text-nero-accent hover:bg-nero-surface-hover"
            >
              <RotateCcwIcon size={12} /> Retry
            </button>
          </div>
        )}

        {/* Detection overlay canvas */}
        <canvas
          ref={canvasRef}
          className="absolute inset-0 pointer-events-none w-full h-full z-10"
        />
      </div>

      {/* Camera Footer */}
      <div className="w-full flex items-center justify-between mt-3 text-xs text-nero-text-muted">
        <span className="font-semibold text-nero-text-primary">{camera.name} ({camera.code})</span>
        <span>Zone: {camera.zone} • Direction: {camera.direction}</span>
      </div>

      {status === 'playing' && <LiveDetectPanel videoRef={videoRef} cameraCode={camera.code} />}
    </div>
  );
}
