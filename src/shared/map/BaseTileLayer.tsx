// ═══════════════════════════════════════════════════
// BaseTileLayer — the app's shared base map; follows the UI theme.
// Labels come from a separate reference layer in a custom `labels` pane
// (z 450: above routes/heat circles in the overlay pane, below markers).
// ═══════════════════════════════════════════════════

import { TileLayer, useMap } from 'react-leaflet';
// Leaflet CSS lives with the map code so it only loads with the (lazy) map chunks.
import './leaflet-theme.css';
import { MAP_TILE_ATTRIBUTION, MAP_TILE_MAX_NATIVE_ZOOM, MAP_TILE_MAX_ZOOM, MAP_TILES } from '@/config/constants';
import { useTheme } from '@/shared/theme/theme';

export const LABELS_PANE = 'labels';

function ensureLabelsPane(map: ReturnType<typeof useMap> | null | undefined): void {
  // Idempotent: the pane must exist before the TileLayer mounts into it.
  if (!map?.getPane || map.getPane(LABELS_PANE)) return;
  const pane = map.createPane(LABELS_PANE);
  pane.style.zIndex = '450';
  pane.style.pointerEvents = 'none';
}

function LabelsLayer({ url }: { url: string }) {
  const map = useMap();
  ensureLabelsPane(map);
  const hasPane = !!map?.getPane?.(LABELS_PANE);
  return (
    <TileLayer
      key={url}
      url={url}
      pane={hasPane ? LABELS_PANE : undefined}
      maxNativeZoom={MAP_TILE_MAX_NATIVE_ZOOM}
      maxZoom={MAP_TILE_MAX_ZOOM}
    />
  );
}

export function BaseTileLayer({ labels = true }: { labels?: boolean }) {
  const { resolved } = useTheme();
  const tiles = MAP_TILES[resolved];
  return (
    <>
      <TileLayer
        key={resolved}
        attribution={MAP_TILE_ATTRIBUTION}
        url={tiles.base}
        maxNativeZoom={MAP_TILE_MAX_NATIVE_ZOOM}
        maxZoom={MAP_TILE_MAX_ZOOM}
      />
      {labels && <LabelsLayer url={tiles.labels} />}
    </>
  );
}
