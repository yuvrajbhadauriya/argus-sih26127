// ═══════════════════════════════════════════════════
// Supabase Data Access Layer — Cameras
// All camera queries go through here, never direct
// from components
// ═══════════════════════════════════════════════════

import type { Camera } from '@/types/camera';
import type { CameraFeed } from '@/types';
import { supabase, isSupabaseConfigured } from '@/lib/supabase/client';
import { mockCameras } from '@/mocks/fixtures/mockCameras';
import { LOCAL_VIDEO_BASE, SUPABASE_STORAGE_BASE, SUPABASE_VIDEO_PREFIX } from '@/config/constants';
import { env, type VideoSource } from '@/config/env';

// Re-exported for existing callers/tests.
export { SUPABASE_STORAGE_BASE };

export interface CameraVideo {
  code: string;
  /** Lower-case ids / legacy codes that also identify this camera (cam-001, cam-a, …). */
  aliases: string[];
  /** Clip name: <slug>.mp4 and <slug>.jpg (poster) in both video sources. */
  slug: string;
}

/** Camera → clip registry, derived from the single camera registry (mockCameras). */
export const CAMERA_VIDEOS: CameraVideo[] = mockCameras.map((c, i) => ({
  code: c.code,
  aliases: [c.id, c.id.replace('-', '_'), c.code.toLowerCase(), `cam-${String.fromCharCode(97 + i)}`],
  slug: c.video_slug ?? '',
}));

export interface CameraMedia {
  /** Stream URL for the configured source. */
  video: string;
  /** Poster frame for the same clip. */
  poster: string;
  /** Alternative stream to try once if `video` fails (the other source), or '' when none. */
  fallback: string;
}

/** URLs of one clip in a given source. */
export function clipUrls(slug: string, source: VideoSource = env.videoSource): { video: string; poster: string } {
  const base = source === 'local' ? LOCAL_VIDEO_BASE : `${SUPABASE_STORAGE_BASE}${SUPABASE_VIDEO_PREFIX}`;
  return { video: `${base}${slug}.mp4`, poster: `${base}${slug}.jpg` };
}

function findCameraVideo(url?: string, code?: string, id?: string): CameraVideo | undefined {
  const c = (code || '').toLowerCase();
  const i = (id || '').toLowerCase();
  return (
    CAMERA_VIDEOS.find((v) => url && v.slug && url.includes(v.slug)) ??
    CAMERA_VIDEOS.find((v) => (c && (v.code.toLowerCase() === c || v.aliases.includes(c))) || (i && v.aliases.includes(i)))
  );
}

/**
 * Resolve a camera's clip. Registry cameras always play their registry clip
 * from the configured source (VITE_VIDEO_SOURCE), with the other source as a
 * one-shot fallback — so a stale `video_url` in the database can never show
 * the wrong footage. Unknown cameras keep an absolute `video_url`; anything
 * else gets a deterministic registry clip so two cameras never look identical.
 */
export function resolveCameraMedia(
  url?: string,
  code?: string,
  id?: string,
  source: VideoSource = env.videoSource,
): CameraMedia {
  const other: VideoSource = source === 'local' ? 'supabase' : 'local';
  const known = findCameraVideo(url, code, id);
  if (known) {
    const primary = clipUrls(known.slug, source);
    return { ...primary, fallback: clipUrls(known.slug, other).video };
  }
  if (url && /^https?:\/\//.test(url)) return { video: url, poster: '', fallback: '' };

  const seedStr = code || id || url || 'default';
  let hash = 0;
  for (let k = 0; k < seedStr.length; k++) hash = (hash << 5) - hash + seedStr.charCodeAt(k);
  const slug = CAMERA_VIDEOS[Math.abs(hash) % CAMERA_VIDEOS.length].slug;
  return { ...clipUrls(slug, source), fallback: clipUrls(slug, other).video };
}

/** Stream URL for a camera (see resolveCameraMedia). */
export function resolveVideoUrl(url?: string, code?: string, id?: string, source?: VideoSource): string {
  return resolveCameraMedia(url, code, id, source).video;
}

/** @deprecated Use `resolveVideoUrl` (clips are no longer always on Supabase). */
export const resolveSupabaseVideoUrl = resolveVideoUrl;

/**
 * Map a `CameraFeed` (mock data shape) into the canonical `Camera` type.
 * Handles the lat/lng → latitude/longitude rename.
 */
function cameraFeedToCamera(feed: CameraFeed): Camera {
  return {
    id: feed.id,
    name: feed.name,
    code: feed.code,
    latitude: feed.lat,
    longitude: feed.lng,
    zone: feed.zone,
    direction: feed.direction,
    road: feed.road,
    status: feed.status === 'maintenance' ? 'offline' : feed.status,
    ...media(feed.video_url, feed.code, feed.id),
    created_at: feed.created_at,
  };
}

function media(url: string | undefined, code: string, id: string) {
  const m = resolveCameraMedia(url, code, id);
  return { video_url: m.video, ...(m.poster ? { poster_url: m.poster } : {}) };
}

/**
 * Map a raw Supabase row into the canonical `Camera` type.
 * The DB columns are `lat` and `lng`; we normalise to `latitude` / `longitude`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToCamera(row: any): Camera {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    latitude: row.lat ?? row.latitude,
    longitude: row.lng ?? row.longitude,
    zone: row.zone,
    direction: row.direction,
    road: row.road ?? undefined,
    status: row.status,
    ...media(row.video_url, row.code, row.id),
    created_at: row.created_at,
  };
}

/** Fetch all cameras, ordered by code */
export async function getCameras(): Promise<Camera[]> {
  if (!isSupabaseConfigured()) {
    // Fallback to mock data when Supabase isn't set up
    return mockCameras.map(cameraFeedToCamera);
  }

  const { data, error } = await supabase
    .from('cameras')
    .select('*')
    .order('code');

  if (error) {
    throw new Error(`Failed to fetch cameras: ${error.message}`);
  }

  return (data ?? []).map(rowToCamera);
}

/** Fetch a single camera by ID */
export async function getCameraById(id: string): Promise<Camera | null> {
  if (!isSupabaseConfigured()) {
    const found = mockCameras.find((c) => c.id === id);
    return found ? cameraFeedToCamera(found) : null;
  }

  const { data, error } = await supabase
    .from('cameras')
    .select('*')
    .eq('id', id)
    .single();

  if (error) {
    throw new Error(`Failed to fetch camera: ${error.message}`);
  }

  return data ? rowToCamera(data) : null;
}

/** Fetch cameras by zone */
export async function getCamerasByZone(zone: string): Promise<Camera[]> {
  if (!isSupabaseConfigured()) {
    return mockCameras
      .filter((c) => c.zone === zone)
      .map(cameraFeedToCamera);
  }

  const { data, error } = await supabase
    .from('cameras')
    .select('*')
    .eq('zone', zone)
    .order('code');

  if (error) {
    throw new Error(`Failed to fetch cameras by zone: ${error.message}`);
  }

  return (data ?? []).map(rowToCamera);
}

// ── Legacy aliases (keep existing callers working) ──

/** @deprecated Use `getCameras` instead */
export const fetchCameras = getCameras;
/** @deprecated Use `getCameraById` instead */
export const fetchCameraById = getCameraById;
/** @deprecated Use `getCamerasByZone` instead */
export const fetchCamerasByZone = getCamerasByZone;
