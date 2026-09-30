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

/** Esri Dark Gray base map, shared by every Leaflet map in the app. */
export const MAP_TILE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}';
export const MAP_TILE_ATTRIBUTION = 'Tiles © Esri — Esri, DeLorme, NAVTEQ';
export const MAP_TILE_MAX_ZOOM = 20;
