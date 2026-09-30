// ═══════════════════════════════════════════════════
// App-wide constants (map defaults, tile layer, storage)
// ═══════════════════════════════════════════════════

// ── Supabase Storage ──────────────────────────────
// The camera videos live in the public `videos` bucket of this project.
// Intentionally NOT derived from VITE_SUPABASE_URL: the deployed env is not
// guaranteed to point at the same project as the video bucket.
export const SUPABASE_PROJECT_REF = 'ngwrbxiaeressvmhfopb';
export const SUPABASE_STORAGE_BASE = `https://${SUPABASE_PROJECT_REF}.supabase.co/storage/v1/object/public/videos/`;

// ── Map ───────────────────────────────────────────
/** Fallback coordinates (India Gate, New Delhi) for records with no lat/lng. */
export const DEFAULT_LOCATION = { lat: 28.6129, lng: 77.2295 } as const;

/** Initial Leaflet view for the live camera map (central New Delhi). */
export const DEFAULT_MAP_CENTER: [number, number] = [28.61, 77.2];
export const DEFAULT_MAP_ZOOM = 12;

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
