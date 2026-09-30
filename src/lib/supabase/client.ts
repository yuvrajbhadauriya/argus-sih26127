// ═══════════════════════════════════════════════════
// Supabase Client — Auth only. Data goes through /api/data (src/lib/dataApi.ts):
// the database is private and the anon key can read no table.
// Single, lazily created instance for the entire app.
// Reads VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (via config/env).
//
// @supabase/supabase-js (~55 kB gz) is loaded with a dynamic import on the
// first getSupabase() call, so pages running on simulated / demo data never
// download it. Always check isSupabaseConfigured() first.
// ═══════════════════════════════════════════════════

import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from '@/config/env';

const supabaseUrl = env.supabaseUrl;
const supabaseAnonKey = env.supabaseAnonKey;

const isValidUrl = Boolean(supabaseUrl && supabaseUrl.startsWith('http'));

/** Check if Supabase is configured (not using placeholder values). Never loads the SDK. */
export function isSupabaseConfigured(): boolean {
  return Boolean(
    isValidUrl &&
    supabaseAnonKey &&
    supabaseUrl !== 'https://your-project.supabase.co' &&
    supabaseAnonKey !== 'your-anon-key'
  );
}

let clientPromise: Promise<SupabaseClient> | null = null;

/**
 * The shared Supabase client (created on first use). Rejects when Supabase is
 * not configured, so callers can't accidentally talk to a placeholder project.
 */
export function getSupabase(): Promise<SupabaseClient> {
  if (!isSupabaseConfigured()) {
    return Promise.reject(new Error('Supabase is not configured (set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY).'));
  }
  if (!clientPromise) {
    clientPromise = import('@supabase/supabase-js')
      .then(({ createClient }) =>
        createClient(supabaseUrl!, supabaseAnonKey!, {
          auth: { persistSession: true, autoRefreshToken: true },
        }),
      )
      .catch((err) => {
        clientPromise = null;
        throw err;
      });
  }
  return clientPromise;
}

/**
 * The signed-in user's access token (for /api/data writes), or null when
 * signed out / not configured. Loads the SDK only when a session may exist.
 */
export async function getAccessToken(): Promise<string | null> {
  if (!isSupabaseConfigured()) return null;
  try {
    const supabase = await getSupabase();
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}
