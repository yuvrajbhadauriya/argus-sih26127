import { describe, it, expect } from 'vitest';
import type { AlertRecord } from '@/types';
import { alertHotspots, topOpenAlerts } from './alerts';
import { formatIstTime, formatRelative, istHour } from './time';

const alert = (over: Partial<AlertRecord>): AlertRecord => ({
  id: 'a', detection_event_id: 'd', blacklist_entry_id: 'b', plate_text: 'DL01AB1234', camera_id: 'cam-001',
  camera_name: 'India Gate', priority: 'low', category: 'stolen', reason: 'r', timestamp: '2026-09-30T10:00:00Z',
  lat: 28.6, lng: 77.2, acknowledged: false, ...over,
});

describe('live-map lib', () => {
  it('orders open alerts by severity then recency', () => {
    const out = topOpenAlerts([
      alert({ id: 'low' }),
      alert({ id: 'crit-old', priority: 'critical', timestamp: '2026-09-30T08:00:00Z' }),
      alert({ id: 'crit-new', priority: 'critical', timestamp: '2026-09-30T09:00:00Z' }),
      alert({ id: 'acked', priority: 'critical', acknowledged: true }),
    ]);
    expect(out.map((a) => a.id)).toEqual(['crit-new', 'crit-old', 'low']);
    expect(topOpenAlerts([alert({}), alert({ id: 'b' })], 1)).toHaveLength(1);
  });

  it('groups open alerts into hotspots with the worst severity', () => {
    const hs = alertHotspots([alert({}), alert({ id: 'b', priority: 'high' }), alert({ id: 'c', camera_id: 'cam-2' }), alert({ id: 'd', acknowledged: true, camera_id: 'cam-3' })]);
    expect(hs).toHaveLength(2);
    expect(hs[0]).toMatchObject({ key: 'cam-001', count: 2, worst: 'high' });
  });

  it('formats IST times regardless of the host timezone', () => {
    expect(formatIstTime('2026-09-30T10:00:00Z')).toBe('15:30:00');
    expect(istHour(new Date('2026-09-30T20:00:00Z'))).toBe(1);
    expect(formatIstTime('nope')).toBe('—');
  });

  it('formats relative times', () => {
    const now = Date.parse('2026-09-30T10:00:00Z');
    expect(formatRelative(now - 5_000, now)).toBe('5s ago');
    expect(formatRelative(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(formatRelative(now - 3 * 3600_000, now)).toBe('3 h ago');
    expect(formatRelative(now - 72 * 3600_000, now)).toBe('3 d ago');
  });
});
