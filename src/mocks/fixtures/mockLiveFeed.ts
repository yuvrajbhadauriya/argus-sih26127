// ═══════════════════════════════════════════════════
// Mock live ANPR feed for the Live Map right rail.
// Stands in for a realtime detections stream until one is wired up: the newest
// reads of the simulated Mumbai network (public/sim) up to its last watchlist
// hit, taken from simDemo.generated.ts. `secondsAgo` is relative to render
// time; `watchlist` marks plates on the watchlist (mockAlerts.mockBlacklistEntries).
// ═══════════════════════════════════════════════════

import type { AlertPriority, PlateColour, VehicleType } from '@/types';
import { SIM_LIVE_FEED } from './simDemo.generated';

export interface LiveFeedEntry {
  id: string;
  plate: string;
  cameraCode: string;
  cameraName: string;
  vehicleType: VehicleType;
  /** Plate colour (yellow taxis / goods, green EVs). */
  plateVariant?: PlateColour;
  /** 0–100 */
  confidence: number;
  secondsAgo: number;
  /** Watchlist priority when the plate is on the watchlist, else null */
  watchlist: AlertPriority | null;
}

export const mockLiveFeed: LiveFeedEntry[] = SIM_LIVE_FEED.map((e) => ({
  ...e,
  vehicleType: e.vehicleType as VehicleType,
  plateVariant: e.plateVariant as PlateColour,
  watchlist: e.watchlist as AlertPriority | null,
}));
