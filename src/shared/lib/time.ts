// IST (Asia/Kolkata, 24h) formatting helpers — every timestamp in the UI is IST.

const TIME_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const HM_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
const DATE_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', day: '2-digit', month: 'short' });
const HOUR_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false });

const toDate = (d: Date | string | number): Date => (d instanceof Date ? d : new Date(d));

/** 'HH:mm:ss' in IST. */
export function formatIstTime(d: Date | string | number): string {
  return TIME_FMT.format(toDate(d));
}
/** 'HH:mm' in IST. */
export function formatIstHm(d: Date | string | number): string {
  return HM_FMT.format(toDate(d));
}
/** 'Wed 30 Sept' style short date in IST. */
export function formatIstDate(d: Date | string | number): string {
  return DATE_FMT.format(toDate(d)).replace(',', '');
}
/** Hour of day 0..23 in IST. */
export function istHour(d: Date | string | number = new Date()): number {
  return Number(HOUR_FMT.format(toDate(d))) % 24;
}
/** Relative time, e.g. '5 min ago', for title attributes. */
export function formatRelative(d: Date | string | number, now: number = Date.now()): string {
  const s = Math.round((now - toDate(d).getTime()) / 1000);
  const abs = Math.abs(s);
  const fmt = (v: number, u: string) => (s >= 0 ? `${v} ${u} ago` : `in ${v} ${u}`);
  if (abs < 45) return s >= 0 ? 'just now' : 'in a moment';
  if (abs < 3600) return fmt(Math.round(abs / 60), 'min');
  if (abs < 86400) return fmt(Math.round(abs / 3600), 'h');
  return fmt(Math.round(abs / 86400), 'd');
}
