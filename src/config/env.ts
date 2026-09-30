// ═══════════════════════════════════════════════════
// Environment — the only place that reads import.meta.env
// ═══════════════════════════════════════════════════

/** Where camera clips are streamed from. */
export type VideoSource = 'local' | 'supabase';

/**
 * VITE_VIDEO_SOURCE=local    → /videos-local/<slug>.mp4 (dev copies made by
 *                              pipeline/tools/link_local_videos.py; gitignored)
 * VITE_VIDEO_SOURCE=supabase → Supabase Storage videos/mumbai/720p/<slug>.mp4
 * Unset: local in `npm run dev`, supabase in production builds.
 */
function readVideoSource(): VideoSource {
  const raw = String(import.meta.env.VITE_VIDEO_SOURCE ?? '').trim().toLowerCase();
  if (raw === 'local' || raw === 'supabase') return raw;
  return import.meta.env.DEV ? 'local' : 'supabase';
}

export const env = {
  /** Supabase project URL, e.g. https://<ref>.supabase.co */
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL as string | undefined,
  /** Supabase anon (public) key */
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined,
  /** Camera clip source (see readVideoSource). */
  videoSource: readVideoSource(),
} as const;
