// ═══════════════════════════════════════════════════
// Mock audit logs & user accounts (Admin)
// Audit entries follow the simulated day of the alert feed (29 Sep 2026 IST).
// ═══════════════════════════════════════════════════

import type { AuditLogEntry } from '@/types';

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

export const mockAuditLogs: AuditLogEntry[] = [
  audit('aud-009', 'VEHICLE_SEARCH', 'vehicle', 'HR 98 CQ 5768', alpha, 'Traced circling route for plate HR 98 CQ 5768 (Connaught Place and India Gate)', '2026-09-29T21:55:10+05:30'),
  audit('aud-008', 'ALERT_ACKNOWLEDGE', 'alert', 'alt-J03271-1', beta, 'Acknowledged watchlist alert for DL 08 MN 8636 at India Gate Junction', '2026-09-29T20:43:02+05:30'),
  audit('aud-007', 'VEHICLE_SEARCH', 'vehicle', 'DL 04 RS 9598', admin, 'Reconstructed multi-camera journey for stolen vehicle DL 04 RS 9598', '2026-09-29T19:40:31+05:30'),
  audit('aud-006', 'REPORT_EXPORT', 'analytics', 'od-matrix', analyst, 'Exported evening-peak origin–destination matrix', '2026-09-29T18:05:44+05:30'),
  audit('aud-005', 'ALERT_ACKNOWLEDGE', 'alert', 'alt-J01729-3', alpha, 'Acknowledged watchlist alert for DL 55 UJ 4753 at Connaught Place Circle', '2026-09-29T12:20:12+05:30'),
  audit('aud-004', 'VEHICLE_SEARCH', 'vehicle', 'DL 33 DV 8622', admin, 'Investigated possible cloned plate DL 33 DV 8622 (CP-01 and DW-01)', '2026-09-29T09:15:03+05:30'),
  audit('aud-003', 'WATCHLIST_ADD', 'blacklist_entry', 'bl-004', admin, 'Added high priority watchlist entry for DL 55 UJ 4753 (missing person)', '2026-09-28T18:40:00+05:30'),
  audit('aud-002', 'WATCHLIST_ADD', 'blacklist_entry', 'bl-001', admin, 'Added critical priority watchlist entry for DL 04 RS 9598 (stolen)', '2026-09-27T10:00:00+05:30'),
  audit('aud-001', 'CAMERA_UPDATE', 'camera', 'NP-01', admin, 'Updated road metadata for Nehru Place Underpass (Outer Ring Road)', '2026-09-26T16:20:00+05:30'),
];
