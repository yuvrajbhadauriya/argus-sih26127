// ═══════════════════════════════════════════════════
// Time helpers shared by the Live Map / Cameras / Detections screens.
// All operator-facing clock times are IST (Asia/Kolkata), 24h.
// ═══════════════════════════════════════════════════

const IST = 'Asia/Kolkata';

/** Hour of day (0–23) in IST for the given instant. */
export function istHour(date: Date = new Date()): number {
  const h = new Intl.DateTimeFormat('en-GB', { timeZone: IST, hour: '2-digit', hour12: false }).format(date);
  return Number(h) % 24;
}

/** "HH:mm:ss" in IST (24h). */
export function formatIstTime(input: string | number | Date): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: IST, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(d);
}

/** Compact relative time: "12s ago", "5 min ago", "3 h ago", "2 d ago". */
export function formatRelative(input: string | number | Date, now: number = Date.now()): string {
  const t = input instanceof Date ? input.getTime() : new Date(input).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
