// ═══════════════════════════════════════════════════
// Mock watchlist entries & alert records
//
// The alert feed mirrors the simulated city network (public/sim): every
// camera read of a curated watchlist plate is a watchlist hit, and the two
// anomaly cases in summary.json (cloned plate, circling) are route-anomaly
// alerts. Tuples below were extracted from public/sim/journeys.json and are
// cross-checked against it in src/features/alerts/fixtures.test.ts.
// ═══════════════════════════════════════════════════

import type { BlacklistEntry, AlertPriority, WatchlistCategory } from '@/types';
import type { TriageAlert } from '@/features/alerts/types';
import { mockCameras } from './mockCameras';

/** Date of the simulated day (IST). */
export const SIM_ALERT_DATE = '2026-09-29';
const ist = (hms: string) => `${SIM_ALERT_DATE}T${hms}+05:30`;

interface WatchSeed {
  plate_text: string;
  category: WatchlistCategory;
  priority: AlertPriority;
  reason: string;
  created: string;
}

/** Curated watchlist of the simulated network (same order as summary.json demo.watchlist). */
const WATCH: WatchSeed[] = [
  { plate_text: 'DL 04 RS 9598', category: 'stolen', priority: 'critical', reason: 'Reported stolen from Dwarka Sector 21 (simulated FIR)', created: '2026-09-27T10:00:00+05:30' },
  { plate_text: 'DL 08 MN 8636', category: 'wanted', priority: 'high', reason: 'Linked to chain-snatching cases in Old Delhi (simulated)', created: '2026-09-26T14:30:00+05:30' },
  { plate_text: 'DL 05 MA 6069', category: 'flagged', priority: 'medium', reason: 'Repeated red-light violations on Ring Road (simulated)', created: '2026-09-20T09:15:00+05:30' },
  { plate_text: 'DL 55 UJ 4753', category: 'missing', priority: 'high', reason: 'Vehicle of a missing person report (simulated)', created: '2026-09-28T18:40:00+05:30' },
];

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
  entry('bl-005', { plate_text: 'HR 26 CD 5678', category: 'stolen', priority: 'high', reason: 'Reported stolen luxury SUV in Gurugram', created: '2026-09-01T10:00:00+05:30' }),
  entry('bl-006', { plate_text: 'DL 03 IJ 7890', category: 'wanted', priority: 'critical', reason: 'Vehicle associated with armed robbery investigation', created: '2026-09-15T14:30:00+05:30' }),
  entry('bl-007', { plate_text: 'UP 16 GH 3456', category: 'flagged', priority: 'low', reason: 'Unpaid commercial highway toll violations', created: '2026-09-10T09:15:00+05:30' }, false),
];

/** [watchlist index, journey id, sighting index, camera code, IST time] */
type Hit = [number, string, number, string, string];
const HITS: Hit[] = [
  [0, 'J00988', 0, 'DW-01', '08:05:00'], [0, 'J00988', 1, 'DK-01', '08:35:37'], [0, 'J00988', 2, 'AI-01', '08:54:07'],
  [0, 'J00988', 3, 'LN-01', '09:08:44'], [0, 'J00988', 4, 'NP-01', '09:32:40'], [0, 'J02946', 0, 'NP-01', '18:40:05'],
  [0, 'J02946', 1, 'LN-01', '19:04:46'], [0, 'J02946', 2, 'AI-01', '19:31:29'], [0, 'J02946', 3, 'DK-01', '19:58:25'],
  [0, 'J02946', 4, 'DW-01', '20:35:21'],
  [1, 'J00888', 0, 'CC-01', '07:30:01'], [1, 'J00888', 1, 'CP-01', '07:46:43'], [1, 'J00888', 2, 'IG-01', '08:00:04'],
  [1, 'J00888', 3, 'AI-01', '08:27:42'], [1, 'J00888', 4, 'LN-01', '08:40:07'], [1, 'J02011', 0, 'LN-01', '13:10:49'],
  [1, 'J02011', 1, 'NP-01', '13:29:38'], [1, 'J03271', 0, 'NP-01', '20:15:14'], [1, 'J03271', 1, 'IG-01', '20:40:50'],
  [1, 'J03271', 2, 'CC-01', '20:54:14'],
  [2, 'J01538', 0, 'DK-01', '10:20:27'], [2, 'J01538', 1, 'KB-01', '10:43:56'], [2, 'J01538', 2, 'CC-01', '10:59:48'],
  [2, 'J02538', 0, 'CC-01', '16:45:46'], [2, 'J02538', 1, 'CP-01', '17:07:02'], [2, 'J02538', 2, 'DK-01', '17:38:52'],
  [2, 'J02538', 3, 'DW-01', '18:40:15'],
  [3, 'J00791', 0, 'LN-01', '06:50:26'], [3, 'J00791', 1, 'AI-01', '07:08:58'], [3, 'J00791', 2, 'DK-01', '07:31:19'],
  [3, 'J00791', 3, 'DW-01', '08:16:44'], [3, 'J01729', 0, 'DW-01', '11:30:31'], [3, 'J01729', 1, 'DK-01', '11:51:41'],
  [3, 'J01729', 2, 'KB-01', '12:07:42'], [3, 'J01729', 3, 'CP-01', '12:17:59'], [3, 'J01729', 4, 'IG-01', '12:24:12'],
  [3, 'J03047', 0, 'IG-01', '19:05:48'], [3, 'J03047', 1, 'LN-01', '19:34:49'],
];

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
export const mockAnomalyAlerts: TriageAlert[] = [
  {
    id: 'anm-clone-DL33DV8622',
    detection_event_id: 'sim-J01251-0',
    blacklist_entry_id: '',
    plate_text: 'DL 33 DV 8622',
    camera_id: camera('DW-01').id,
    camera_name: camera('DW-01').name,
    priority: 'critical',
    category: 'flagged',
    reason: 'Possible cloned plate: read at Connaught Place Circle and Dwarka Expressway Entry 3 min apart; 25.7 km by road needs ~51 min (implied 503 km/h)',
    timestamp: ist('09:06:52'),
    lat: camera('DW-01').lat,
    lng: camera('DW-01').lng,
    acknowledged: false,
    kind: 'cloned_plate',
    camera_code: 'DW-01',
    evidence: [
      { camera_code: 'CP-01', timestamp: ist('09:03:48') },
      { camera_code: 'DW-01', timestamp: ist('09:06:52') },
    ],
    simulated: true,
  },
  {
    id: 'anm-circling-HR98CQ5768',
    detection_event_id: 'sim-J03420-6',
    blacklist_entry_id: '',
    plate_text: 'HR 98 CQ 5768',
    camera_id: camera('CP-01').id,
    camera_name: camera('CP-01').name,
    priority: 'high',
    category: 'flagged',
    reason: 'Suspicious circling: looped Connaught Place and India Gate 3 times in 45 min with no destination',
    timestamp: ist('21:51:25'),
    lat: camera('CP-01').lat,
    lng: camera('CP-01').lng,
    acknowledged: false,
    kind: 'circling',
    camera_code: 'CP-01',
    evidence: [
      ['CP-01', '21:05:41'], ['IG-01', '21:13:56'], ['CP-01', '21:21:51'], ['IG-01', '21:29:31'],
      ['CP-01', '21:37:10'], ['IG-01', '21:44:06'], ['CP-01', '21:51:25'],
    ].map(([camera_code, hms]) => ({ camera_code, timestamp: ist(hms) })),
    simulated: true,
  },
];

/** The full mock feed (newest first). Shares objects with the arrays above. */
export const mockAlertFeed: TriageAlert[] = [...mockAnomalyAlerts, ...mockAlerts].sort(
  (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp),
);
