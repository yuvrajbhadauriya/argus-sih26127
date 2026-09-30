import { describe, it, expect } from 'vitest';
import type { AlertRecord } from '@/types';
import { medianAckSeconds, newAlertIds, relativeTime, sortForTriage } from './triage';

const a = (id: string, priority: AlertRecord['priority'], ts: string, ack?: string): AlertRecord => ({
  id, priority, timestamp: ts, detection_event_id: id, blacklist_entry_id: '', plate_text: id, camera_id: 'c', camera_name: 'C',
  category: 'stolen', reason: '', lat: 0, lng: 0, acknowledged: !!ack, acknowledged_at: ack,
});

describe('triage helpers', () => {
  it('sorts by severity then newest first', () => {
    const out = sortForTriage([
      a('low', 'low', '2026-09-29T10:00:00Z'),
      a('crit-old', 'critical', '2026-09-29T08:00:00Z'),
      a('crit-new', 'critical', '2026-09-29T09:00:00Z'),
      a('high', 'high', '2026-09-29T11:00:00Z'),
    ]);
    expect(out.map((x) => x.id)).toEqual(['crit-new', 'crit-old', 'high', 'low']);
  });

  it('median time to acknowledge', () => {
    expect(medianAckSeconds([])).toBeNull();
    expect(medianAckSeconds([
      a('1', 'high', '2026-09-29T10:00:00Z', '2026-09-29T10:01:00Z'),
      a('2', 'high', '2026-09-29T10:00:00Z', '2026-09-29T10:03:00Z'),
      a('3', 'high', '2026-09-29T10:00:00Z'),
    ])).toBe(120);
  });

  it('relative time and new ids', () => {
    const now = Date.parse('2026-09-29T12:00:00Z');
    expect(relativeTime('2026-09-29T11:55:00Z', now)).toBe('5 min ago');
    expect(relativeTime('2026-09-28T11:00:00Z', now)).toBe('1 d ago');
    expect(newAlertIds([a('1', 'low', '')], [a('2', 'low', ''), a('1', 'low', '')])).toEqual(['2']);
  });
});
