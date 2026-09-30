// ═══════════════════════════════════════════════════
// Mock audit logs & user accounts (Admin)
// Audit entries follow the simulated day of the alert feed (29 Sep 2026 IST).
// ═══════════════════════════════════════════════════

import type { AuditLogEntry } from '@/types';
import { mockCameras } from './mockCameras';
import { SIM_ANOMALIES, SIM_DATE, SIM_WATCH_HITS, SIM_WATCHLIST } from './simDemo.generated';

export type UserRole = 'admin' | 'operator' | 'analyst';

export interface UserAccount {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: 'active' | 'suspended';
  /** ISO timestamp of the last activity. */
  last_active: string;
}

export const mockUsers: UserAccount[] = [
  { id: 'usr-01', name: 'Command Officer', email: 'admin@nero.city.gov', role: 'admin', status: 'active', last_active: '2026-09-29T21:58:00+05:30' },
  { id: 'usr-02', name: 'Operator Alpha', email: 'op1@nero.city.gov', role: 'operator', status: 'active', last_active: '2026-09-29T21:40:00+05:30' },
  { id: 'usr-03', name: 'Operator Beta', email: 'op2@nero.city.gov', role: 'operator', status: 'active', last_active: '2026-09-29T20:12:00+05:30' },
  { id: 'usr-04', name: 'Traffic Analyst', email: 'analyst@nero.city.gov', role: 'analyst', status: 'active', last_active: '2026-09-29T18:05:00+05:30' },
  { id: 'usr-05', name: 'Operator Gamma', email: 'op3@nero.city.gov', role: 'operator', status: 'suspended', last_active: '2026-09-21T09:30:00+05:30' },
];

const audit = (
  id: string,
  action: string,
  entity_type: string,
  entity_id: string,
  user: UserAccount,
  details: string,
  timestamp: string,
): AuditLogEntry => ({ id, action, entity_type, entity_id, user_id: user.id, user_email: user.email, details, timestamp });

const [admin, alpha, beta, analyst] = mockUsers;

const [stolen, wanted, flagged, missing] = SIM_WATCHLIST;
const clone = SIM_ANOMALIES.find((x) => x.kind === 'cloned_plate')!;
const circling = SIM_ANOMALIES.find((x) => x.kind === 'circling')!;
const hit = (plate: number, n: number) => SIM_WATCH_HITS.filter((h) => h[0] === plate)[n];
const camName = (code: string) => mockCameras.find((c) => c.code === code)?.name ?? code;
const at = (hms: string, addS = 0) => {
  const t = new Date(`${SIM_DATE}T${hms}+05:30`).getTime() + addS * 1000;
  const d = new Date(t + 5.5 * 3600 * 1000).toISOString().slice(0, 19);
  return `${d}+05:30`;
};
const wantedLate = hit(1, 5);
const missingMid = hit(3, 6);

export const mockAuditLogs: AuditLogEntry[] = [
  audit('aud-009', 'VEHICLE_SEARCH', 'vehicle', circling.plate_text, alpha, `Traced circling route for plate ${circling.plate_text} (${camName(circling.evidence[0][0])} and ${camName(circling.evidence[1][0])})`, at(circling.time, 310)),
  audit('aud-008', 'ALERT_ACKNOWLEDGE', 'alert', `alt-${wantedLate[1]}-${wantedLate[2]}`, beta, `Acknowledged watchlist alert for ${wanted.plate_text} at ${camName(wantedLate[3])}`, at(wantedLate[4], 230)),
  audit('aud-007', 'VEHICLE_SEARCH', 'vehicle', stolen.plate_text, admin, `Reconstructed multi-camera journey for stolen vehicle ${stolen.plate_text}`, at('19:40:31')),
  audit('aud-006', 'REPORT_EXPORT', 'analytics', 'od-matrix', analyst, 'Exported evening-peak origin–destination matrix', at('18:05:44')),
  audit('aud-005', 'ALERT_ACKNOWLEDGE', 'alert', `alt-${missingMid[1]}-${missingMid[2]}`, alpha, `Acknowledged watchlist alert for ${missing.plate_text} at ${camName(missingMid[3])}`, at(missingMid[4], 340)),
  audit('aud-004', 'VEHICLE_SEARCH', 'vehicle', clone.plate_text, admin, `Investigated possible cloned plate ${clone.plate_text} (${clone.evidence[0][0]} and ${clone.evidence[1][0]})`, at(clone.time, 480)),
  audit('aud-003', 'WATCHLIST_ADD', 'blacklist_entry', 'bl-004', admin, `Added high priority watchlist entry for ${missing.plate_text} (missing person)`, '2026-09-28T18:40:00+05:30'),
  audit('aud-002', 'WATCHLIST_ADD', 'blacklist_entry', 'bl-001', admin, `Added critical priority watchlist entry for ${stolen.plate_text} (stolen)`, '2026-09-27T10:00:00+05:30'),
  audit('aud-001', 'CAMERA_UPDATE', 'camera', 'SN-01', admin, `Updated road metadata for Sion Circle (Sion–Panvel Highway); signal-jumping watch on ${flagged.plate_text}`, '2026-09-26T16:20:00+05:30'),
];
