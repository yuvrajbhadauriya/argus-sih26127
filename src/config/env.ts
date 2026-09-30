// ═══════════════════════════════════════════════════
// Environment — the only place that reads import.meta.env
// ═══════════════════════════════════════════════════

export const env = {
  /** Supabase project URL, e.g. https://<ref>.supabase.co */
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL as string | undefined,
  /** Supabase anon (public) key */
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined,
} as const;
