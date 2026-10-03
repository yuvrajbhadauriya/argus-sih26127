// ═══════════════════════════════════════════════════
// Camera → clip registry (the one place a camera's video is named)
//
// cameraClips.json maps each camera code to its clip slug (<slug>.mp4 and
// <slug>.jpg in public/videos-local/ and in the Supabase `videos` bucket under
// mumbai/720p/). It is also read by pipeline/tools/replace_camera_clip.py,
// which is how a camera gets a new clip; nothing else hard-codes a slug.
// Every slug ends in the Pexels video id (…_pexels<id>), which is the credit.
// ═══════════════════════════════════════════════════

import clips from './cameraClips.json';
import { SUPABASE_STORAGE_BASE, SUPABASE_VIDEO_PREFIX } from './constants';

const SLUGS: Readonly<Record<string, string>> = clips;

/** Clip slug of a camera code, or '' for a code that is not in the registry. */
export function clipSlugFor(code: string): string {
  return SLUGS[code] ?? '';
}

/** Clip slug of a registry camera; throws on an unknown code (a typo in a fixture). */
export function requireClipSlug(code: string): string {
  const slug = SLUGS[code];
  if (!slug) throw new Error(`No clip registered for camera ${code} (src/config/cameraClips.json)`);
  return slug;
}

/** Public-object Storage URL of a clip's mp4 (signed on the way to the player). */
export function supabaseClipUrl(slug: string): string {
  return `${SUPABASE_STORAGE_BASE}${SUPABASE_VIDEO_PREFIX}${slug}.mp4`;
}

/** Pexels video id a clip slug carries ("…_pexels12974288" → "12974288"), or null. */
export function pexelsIdOf(slug: string): string | null {
  return /_pexels(\d+)$/.exec(slug)?.[1] ?? null;
}

/** Pexels page (credit and licence) of a clip, or null for a slug without an id. */
export function pexelsUrlOf(slug: string): string | null {
  const id = pexelsIdOf(slug);
  return id ? `https://www.pexels.com/video/${id}/` : null;
}
