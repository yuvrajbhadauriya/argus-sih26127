// ═══════════════════════════════════════════════════
// BaseTileLayer — the app's shared dark base map tiles
// ═══════════════════════════════════════════════════

import { TileLayer } from 'react-leaflet';
// Leaflet CSS lives with the map code so it only loads with the (lazy) map chunks.
import './leaflet-theme.css';
import { MAP_TILE_ATTRIBUTION, MAP_TILE_MAX_ZOOM, MAP_TILE_URL } from '@/config/constants';

export function BaseTileLayer() {
  return <TileLayer attribution={MAP_TILE_ATTRIBUTION} url={MAP_TILE_URL} maxZoom={MAP_TILE_MAX_ZOOM} />;
}
