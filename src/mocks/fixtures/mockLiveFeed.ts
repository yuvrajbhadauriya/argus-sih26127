// ═══════════════════════════════════════════════════
// Mock live ANPR feed for the Live Map right rail.
// Stands in for a realtime detections stream until one is wired up.
// `secondsAgo` is relative to render time; `watchlist` marks plates that are
// on the watchlist (see mockAlerts.mockBlacklistEntries).
// ═══════════════════════════════════════════════════

import type { AlertPriority, VehicleType } from '@/types';

export interface LiveFeedEntry {
  id: string;
  plate: string;
  cameraCode: string;
  cameraName: string;
  vehicleType: VehicleType;
  /** 0–100 */
  confidence: number;
  secondsAgo: number;
  /** Watchlist priority when the plate is on the watchlist, else null */
  watchlist: AlertPriority | null;
}

export const mockLiveFeed: LiveFeedEntry[] = [
  { id: 'lf-1', plate: 'DL-01-AB-1234', cameraCode: 'IG-01', cameraName: 'India Gate Junction', vehicleType: 'car', confidence: 96, secondsAgo: 2, watchlist: null },
  { id: 'lf-2', plate: 'HR-26-CD-5678', cameraCode: 'CP-01', cameraName: 'Connaught Place Circle', vehicleType: 'truck', confidence: 94, secondsAgo: 5, watchlist: 'high' },
  { id: 'lf-3', plate: 'DL-02-EF-9012', cameraCode: 'AI-01', cameraName: 'AIIMS T-Junction', vehicleType: 'bus', confidence: 91, secondsAgo: 12, watchlist: null },
  { id: 'lf-4', plate: 'UP-16-GH-3456', cameraCode: 'NP-01', cameraName: 'Nehru Place Underpass', vehicleType: 'car', confidence: 89, secondsAgo: 18, watchlist: 'medium' },
  { id: 'lf-5', plate: 'DL-03-IJ-7890', cameraCode: 'KB-01', cameraName: 'Karol Bagh Crossing', vehicleType: 'motorcycle', confidence: 88, secondsAgo: 25, watchlist: 'critical' },
  { id: 'lf-6', plate: 'RJ-14-KL-2345', cameraCode: 'IG-01', cameraName: 'India Gate Junction', vehicleType: 'car', confidence: 97, secondsAgo: 31, watchlist: null },
  { id: 'lf-7', plate: 'DL-04-MN-6789', cameraCode: 'DW-01', cameraName: 'Dwarka Expressway Entry', vehicleType: 'truck', confidence: 85, secondsAgo: 40, watchlist: null },
];
