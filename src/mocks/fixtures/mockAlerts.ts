// ═══════════════════════════════════════════════════
// Mock watchlist entries & alert records
//
// The alert feed mirrors the simulated Mumbai network (public/sim): every
// camera read of a curated watchlist plate is a watchlist hit, and the two
// anomaly cases in summary.json (cloned plate, circling) are route-anomaly
// alerts. The data comes from simDemo.generated.ts (written by
// pipeline/simulation/export_demo_fixtures.py) and is cross-checked against
// public/sim in src/features/alerts/fixtures.test.ts.
// ═══════════════════════════════════════════════════

import type { BlacklistEntry, AlertPriority, WatchlistCategory } from '@/types';
import type { TriageAlert } from '@/features/alerts/types';
import { mockCameras } from './mockCameras';
import { SIM_ANOMALIES, SIM_DATE, SIM_WATCH_HITS, SIM_WATCHLIST } from './simDemo.generated';

/** Date of the simulated day (IST). */
export const SIM_ALERT_DATE = SIM_DATE;
const ist = (hms: string) => `${SIM_ALERT_DATE}T${hms}+05:30`;

interface WatchSeed {
  plate_text: string;
  category: WatchlistCategory;
  priority: AlertPriority;
  reason: string;
  created: string;
}

/** When each curated entry was added to the watchlist (days before the simulated day). */
const CREATED = ['2026-09-27T10:00:00+05:30', '2026-09-26T14:30:00+05:30', '2026-09-20T09:15:00+05:30', '2026-09-28T18:40:00+05:30'];

/** Curated watchlist of the simulated network (same order as summary.json demo.watchlist). */
const WATCH: WatchSeed[] = SIM_WATCHLIST.map((w, i) => ({
  plate_text: w.plate_text,
  category: w.category as WatchlistCategory,
  priority: w.priority as AlertPriority,
  reason: w.reason,
  created: CREATED[i % CREATED.length],
}));

const entry = (id: string, w: WatchSeed, active = true): BlacklistEntry => ({
  id,
  plate_text: w.plate_text,
  category: w.category,
  priority: w.priority,
  reason: w.reason,
  valid_from: w.created,
  valid_to: null,
  is_active: active,
  created_at: w.created,
  updated_at: w.created,
});

export const mockBlacklistEntries: BlacklistEntry[] = [
  ...WATCH.map((w, i) => entry(`bl-00${i + 1}`, w)),
  // Entries without sightings today (keep the watchlist realistic).
  entry('bl-005', { plate_text: 'MH 12 RT 4417', category: 'stolen', priority: 'high', reason: 'SUV reported stolen in Pune; may be moved to Mumbai (simulated)', created: '2026-09-01T10:00:00+05:30' }),
  entry('bl-006', { plate_text: 'GJ 05 KL 2231', category: 'wanted', priority: 'critical', reason: 'Vehicle associated with an armed robbery investigation (simulated)', created: '2026-09-15T14:30:00+05:30' }),
  entry('bl-007', { plate_text: 'MH 04 JB 7780', category: 'flagged', priority: 'low', reason: 'Unpaid e-challans on the Eastern Express Highway (simulated)', created: '2026-09-10T09:15:00+05:30' }, false),
];

/** [watchlist index, journey id, sighting index, camera code, IST time] */
const HITS = SIM_WATCH_HITS;

const OPERATORS = ['Operator Alpha', 'Operator Beta', 'Command Officer'];

function camera(code: string) {
  const c = mockCameras.find((m) => m.code === code);
  if (!c) throw new Error(`mockAlerts: unknown camera ${code}`);
  return c;
}

const lastHitOfPlate = new Map<number, number>();
HITS.forEach(([w], i) => lastHitOfPlate.set(w, i));

/**
 * One alert per watchlist camera hit. Each plate's latest hit is still pending;
 * earlier hits were acknowledged by the duty operators a few minutes later.
 */
export const mockAlerts: TriageAlert[] = HITS.map(([wi, journey, k, code, hms], i) => {
  const w = WATCH[wi];
  const cam = camera(code);
  const timestamp = ist(hms);
  const pending = lastHitOfPlate.get(wi) === i;
  const ackDelayS = 75 + ((i * 53) % 420);
  return {
    id: `alt-${journey}-${k}`,
    detection_event_id: `sim-${journey}-${k}`,
    blacklist_entry_id: `bl-00${wi + 1}`,
    plate_text: w.plate_text,
    camera_id: cam.id,
    camera_name: cam.name,
    priority: w.priority,
    category: w.category,
    reason: w.reason,
    timestamp,
    lat: cam.lat,
    lng: cam.lng,
    acknowledged: !pending,
    ...(pending
      ? {}
      : {
          acknowledged_by: OPERATORS[i % OPERATORS.length],
          acknowledged_at: new Date(Date.parse(timestamp) + ackDelayS * 1000).toISOString(),
        }),
    kind: 'watchlist',
    camera_code: code,
    simulated: true,
  };
});

/** Route-anomaly alerts (summary.json demo.anomalies). */
export const mockAnomalyAlerts: TriageAlert[] = SIM_ANOMALIES.map((a) => {
  const cam = camera(a.camera_code);
  return {
    id: `anm-${a.kind === 'cloned_plate' ? 'clone' : a.kind}-${a.plate_text.replace(/\s+/g, '')}`,
    detection_event_id: `sim-${a.journey}-${a.index}`,
    blacklist_entry_id: '',
    plate_text: a.plate_text,
    camera_id: cam.id,
    camera_name: cam.name,
    priority: a.kind === 'cloned_plate' ? 'critical' : 'high',
    category: 'flagged',
    reason: a.reason,
    timestamp: ist(a.time),
    lat: cam.lat,
    lng: cam.lng,
    acknowledged: false,
    kind: a.kind,
    camera_code: a.camera_code,
    evidence: a.evidence.map(([camera_code, hms]) => ({ camera_code, timestamp: ist(hms) })),
    simulated: true,
  };
});

/** The full mock feed (newest first). Shares objects with the arrays above. */
export const mockAlertFeed: TriageAlert[] = [...mockAnomalyAlerts, ...mockAlerts].sort(
  (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp),
);
