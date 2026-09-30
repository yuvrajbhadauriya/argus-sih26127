// ═══════════════════════════════════════════════════
// App-wide constants (map defaults, tile layer, storage)
// ═══════════════════════════════════════════════════

// ── Supabase Storage ──────────────────────────────
// The camera videos live in the public `videos` bucket of the project in
// VITE_SUPABASE_URL. VITE_VIDEO_BASE_URL overrides it (e.g. a CDN in front).
const FALLBACK_SUPABASE_URL = 'https://zkmtjqsljwwyjpgvgyyp.supabase.co';
const SUPABASE_URL = String(import.meta.env.VITE_SUPABASE_URL || FALLBACK_SUPABASE_URL).replace(/\/+$/, '');
export const SUPABASE_PROJECT_REF = new URL(SUPABASE_URL).hostname.split('.')[0];
export const SUPABASE_STORAGE_BASE = String(
  import.meta.env.VITE_VIDEO_BASE_URL || `${SUPABASE_URL}/storage/v1/object/public/videos/`,
).replace(/\/?$/, '/');
/** Folder of the Mumbai camera clips inside the bucket (<slug>.mp4 + <slug>.jpg poster). */
export const SUPABASE_VIDEO_PREFIX = 'mumbai/720p/';
/** Local dev copies of the same clips (public/videos-local/, gitignored). */
export const LOCAL_VIDEO_BASE = '/videos-local/';

// ── Map ───────────────────────────────────────────
/** Fallback coordinates (Kurla, geographic centre of Mumbai) for records with no lat/lng. */
export const DEFAULT_LOCATION = { lat: 19.076, lng: 72.8777 } as const;

/** Initial Leaflet view for the live camera map (Mumbai: WEH, LBS Marg, Dadar–Sion). */
export const DEFAULT_MAP_CENTER: [number, number] = [19.08, 72.885];
export const DEFAULT_MAP_ZOOM = 12;

/** Command sector shown in the app chrome. */
export const SECTOR_LABEL = 'Mumbai · Central Command Sector';

/** Esri Canvas base maps per theme (base + separate reference labels layer). */
export const MAP_TILES = {
  light: {
    base: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    labels: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
  },
  dark: {
    base: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    labels: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
  },
} as const;
export const MAP_TILE_ATTRIBUTION = 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors';
/** Canvas service detail ends around z16; Leaflet upscales beyond. */
export const MAP_TILE_MAX_NATIVE_ZOOM = 16;
export const MAP_TILE_MAX_ZOOM = 19;
