// Toast text for a new live alert (Realtime or replay).
import { formatIstTime } from '@/features/live-map/lib/time';
import type { AlertEvent } from '../live';
import { ALERT_KIND_LABEL, alertKind } from '../types';

export function alertToastContent(e: AlertEvent) {
  const a = e.alert;
  const kind = alertKind(a);
  const code = a.camera_code ? `${a.camera_code} · ` : '';
  return {
    tone: a.priority === 'critical' || a.priority === 'high' ? ('danger' as const) : ('warning' as const),
    title: `${ALERT_KIND_LABEL[kind]}: ${a.plate_text}`,
    description: `${a.priority.toUpperCase()} · ${code}${a.camera_name} · ${formatIstTime(a.timestamp)} IST${e.source === 'replay' ? ' (replay)' : ''}`,
  };
}
