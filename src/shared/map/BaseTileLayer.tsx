// ═══════════════════════════════════════════════════
// BaseTileLayer — the app's shared dark base map tiles
// ═══════════════════════════════════════════════════

import { TileLayer } from 'react-leaflet';
import { MAP_TILE_ATTRIBUTION, MAP_TILE_MAX_ZOOM, MAP_TILE_URL } from '@/config/constants';

export function BaseTileLayer() {
  return <TileLayer attribution={MAP_TILE_ATTRIBUTION} url={MAP_TILE_URL} maxZoom={MAP_TILE_MAX_ZOOM} />;
}
