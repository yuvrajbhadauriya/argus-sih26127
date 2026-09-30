// ═══════════════════════════════════════════════════
// Golden-set OCR results (public/golden/results_golden_v1.json, written by
// pipeline/tools/upload_golden.py): parser, per-condition breakdown, gallery
// filters and formatting. Every number on /accuracy comes from this file.
// ═══════════════════════════════════════════════════

import type { PlateVariant } from '@/shared/lib/plate';

export const PS_TARGET = 0.9;

export interface GoldenItem {
  key: string;
  gt: string;
  pred: string;
  /** Model confidence, 0–100. */
  confidence: number;
  correct: boolean;
  grammarValid: boolean;
  rowCount: number;
  side: string;
  stateCode: string;
  conditions: string[];
  labelers: number;
  width: number;
  height: number;
  inferenceMs: number | null;
  roundtripMs: number | null;
}

export interface Tally {
  n: number;
  correct: number;
  accuracy: number;
}

export interface GoldenResults {
  set: string;
  setHash: string;
  status: string;
  measuredAt: string;
  endpoint: string;
  totalImages: number;
  scored: number;
  unreadable: number;
  overall: Tally;
  breakdown: Record<string, Tally>;
  latency: { p50: number | null; p95: number | null };
  wallSeconds: number | null;
  /** Private Storage bucket and object prefix of the crops (signed via /api/media/sign). */
  bucket: string;
  prefix: string;
  items: GoldenItem[];
}

type Raw = Record<string, unknown>;

const num = (v: unknown, fallback: number | null = null): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

function tally(v: unknown): Tally {
  const t = (v ?? {}) as Raw;
  const n = num(t.n, 0)!;
  const correct = num(t.correct, 0)!;
  return { n, correct, accuracy: num(t.accuracy) ?? (n ? correct / n : 0) };
}

function item(v: unknown, fields: string[] | null): GoldenItem | null {
  let o: Raw;
  if (Array.isArray(v)) {
    if (!fields) return null;
    o = Object.fromEntries(fields.map((f, i) => [f, v[i]]));
  } else if (v && typeof v === 'object') {
    o = v as Raw;
  } else {
    return null;
  }
  const key = str(o.key);
  const gt = str(o.gt);
  if (!key || !gt) return null;
  const pred = str(o.pred);
  const conditions = Array.isArray(o.conditions) ? o.conditions.filter((c): c is string => typeof c === 'string' && c !== 'clear') : [];
  return {
    key,
    gt,
    pred,
    confidence: num(o.confidence, 0)!,
    correct: o.correct === true || o.correct === 1 || (o.correct == null && pred === gt),
    grammarValid: o.grammar_valid === true || o.grammar_valid === 1,
    rowCount: num(o.row_count, 1)!,
    side: str(o.side, 'unknown'),
    stateCode: str(o.state_code),
    conditions,
    labelers: num(o.labelers, 0)!,
    width: num(o.width, 0)!,
    height: num(o.height, 0)!,
    inferenceMs: num(o.inference_ms),
    roundtripMs: num(o.roundtrip_ms),
  };
}

/** Throws on anything that is not a golden-set results file. */
export function parseGoldenResults(raw: unknown): GoldenResults {
  if (!raw || typeof raw !== 'object') throw new Error('Golden-set results: not an object');
  const r = raw as Raw;
  if (!Array.isArray(r.items)) throw new Error('Golden-set results: missing items');
  const fields = Array.isArray(r.item_fields) ? (r.item_fields as unknown[]).map((f) => String(f)) : null;
  const items = r.items.map((v) => item(v, fields)).filter((x): x is GoldenItem => x !== null);
  if (items.length === 0) throw new Error('Golden-set results: no scored items');
  const breakdown: Record<string, Tally> = {};
  for (const [k, v] of Object.entries((r.breakdown ?? {}) as Raw)) breakdown[k] = tally(v);
  const overall = r.overall ? tally(r.overall) : summarize(items);
  const lat = (r.latency_ms ?? {}) as Raw;
  const skipped = (r.skipped ?? {}) as Raw;
  const prefix = str(r.prefix, 'ocr_golden_v1/');
  return {
    set: str(r.set, 'golden'),
    setHash: str(r.set_hash),
    status: str(r.status),
    measuredAt: str(r.measured_at),
    endpoint: str(r.endpoint),
    totalImages: num(r.total_images, items.length)!,
    scored: num(r.scored, items.length)!,
    unreadable: num(skipped.unreadable, 0)!,
    overall,
    breakdown,
    latency: { p50: num(lat.p50), p95: num(lat.p95) },
    wallSeconds: num(r.wall_seconds),
    bucket: str(r.bucket, 'golden'),
    prefix: prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix,
    items,
  };
}

export function summarize(items: GoldenItem[]): Tally {
  const correct = items.reduce((s, it) => s + (it.correct ? 1 : 0), 0);
  return { n: items.length, correct, accuracy: items.length ? correct / items.length : 0 };
}

/** Breakdown keys of an item, in the file's `group:value` form. */
export function itemGroups(it: GoldenItem): string[] {
  return [...it.conditions.map((c) => `condition:${c}`), `rows:${it.rowCount}`, `side:${it.side}`];
}

/** Recompute the per-group tallies from the items (used to check the file is self-consistent). */
export function computeBreakdown(items: GoldenItem[]): Record<string, Tally> {
  const acc: Record<string, { n: number; correct: number }> = {};
  for (const it of items) {
    for (const g of itemGroups(it)) {
      const t = (acc[g] ??= { n: 0, correct: 0 });
      t.n += 1;
      if (it.correct) t.correct += 1;
    }
  }
  return Object.fromEntries(Object.entries(acc).map(([k, t]) => [k, { ...t, accuracy: t.n ? t.correct / t.n : 0 }]));
}

/** Object path of an item's crop inside the bucket, e.g. 'ocr_golden_v1/<key>.jpg'. */
export function objectPath(r: Pick<GoldenResults, 'prefix'>, it: Pick<GoldenItem, 'key'>): string {
  return `${r.prefix}${it.key}.jpg`;
}

// ── labels ───────────────────────────────────────────

export interface GroupMeta {
  key: string;
  label: string;
  hint: string;
}

/** The breakdown shown as cards, in display order (the rest go to the "small samples" note). */
export const BREAKDOWN_GROUPS: GroupMeta[] = [
  { key: 'condition:day', label: 'Daylight', hint: 'Sunlit plates' },
  { key: 'condition:dusk-dawn', label: 'Dusk / dawn', hint: 'Low, warm light' },
  { key: 'condition:night-vis', label: 'Night · visible', hint: 'Street-light only' },
  { key: 'condition:night-ir', label: 'Night · infrared', hint: 'IR-lit, monochrome' },
  { key: 'condition:commercial-yellow', label: 'Commercial yellow', hint: 'Taxi / goods plates' },
  { key: 'condition:green-ev', label: 'Green EV', hint: 'Electric-vehicle plates' },
  { key: 'condition:hsrp-standard', label: 'Standard HSRP', hint: 'High-security plates' },
  { key: 'rows:2', label: 'Two-row plates', hint: 'Stacked characters' },
  { key: 'rows:1', label: 'Single-row plates', hint: 'One line' },
  { key: 'side:front', label: 'Front plates', hint: 'Approaching vehicles' },
  { key: 'side:rear', label: 'Rear plates', hint: 'Departing vehicles' },
];

const CONDITION_LABELS: Record<string, string> = {
  day: 'Daylight',
  'dusk-dawn': 'Dusk / dawn',
  'night-vis': 'Night · visible',
  'night-ir': 'Night · infrared',
  'commercial-yellow': 'Commercial yellow',
  'green-ev': 'Green EV',
  'hsrp-standard': 'Standard HSRP',
  glare: 'Glare',
  'damaged-plate': 'Damaged plate',
  'non-standard-font': 'Non-standard font',
};

export function conditionLabel(c: string): string {
  return CONDITION_LABELS[c] ?? c.replace(/-/g, ' ');
}

export function groupLabel(key: string): string {
  const meta = BREAKDOWN_GROUPS.find((g) => g.key === key);
  if (meta) return meta.label;
  const [kind, value] = key.split(':');
  if (kind === 'condition') return conditionLabel(value);
  return key;
}

/** Breakdown groups not shown as cards (small, specialised samples), n > 0. */
export function otherGroups(r: GoldenResults): (Tally & { key: string; label: string })[] {
  const shown = new Set(BREAKDOWN_GROUPS.map((g) => g.key));
  return Object.entries(r.breakdown)
    .filter(([k, t]) => !shown.has(k) && k !== 'condition:clear' && t.n > 0)
    .map(([k, t]) => ({ key: k, label: groupLabel(k), ...t }))
    .sort((a, b) => b.n - a.n);
}

/** Samples below this size get a "small sample" marker. */
export const SMALL_SAMPLE = 30;

export function plateVariant(it: Pick<GoldenItem, 'conditions'>): PlateVariant {
  if (it.conditions.includes('green-ev')) return 'ev';
  if (it.conditions.includes('commercial-yellow')) return 'commercial';
  return 'private';
}

// ── gallery filters ─────────────────────────────────

export interface GalleryFilters {
  query: string;
  condition: string; // '' = any
  rows: '' | '1' | '2';
  side: '' | 'front' | 'rear';
  result: '' | 'correct' | 'wrong';
  confidence: '' | 'ge90' | '75to90' | 'lt75';
  sort: 'default' | 'confidence-asc' | 'confidence-desc';
}

export const DEFAULT_FILTERS: GalleryFilters = { query: '', condition: '', rows: '', side: '', result: '', confidence: '', sort: 'default' };

const normQuery = (q: string) => q.toUpperCase().replace(/[^A-Z0-9]/g, '');

export function filterItems(items: GoldenItem[], f: GalleryFilters): GoldenItem[] {
  const q = normQuery(f.query);
  const out = items.filter((it) => {
    if (q && !it.gt.includes(q) && !it.pred.includes(q)) return false;
    if (f.condition && !it.conditions.includes(f.condition)) return false;
    if (f.rows && String(it.rowCount) !== f.rows) return false;
    if (f.side && it.side !== f.side) return false;
    if (f.result === 'correct' && !it.correct) return false;
    if (f.result === 'wrong' && it.correct) return false;
    if (f.confidence === 'ge90' && it.confidence < 90) return false;
    if (f.confidence === '75to90' && (it.confidence < 75 || it.confidence >= 90)) return false;
    if (f.confidence === 'lt75' && it.confidence >= 75) return false;
    return true;
  });
  if (f.sort === 'confidence-asc') out.sort((a, b) => a.confidence - b.confidence);
  else if (f.sort === 'confidence-desc') out.sort((a, b) => b.confidence - a.confidence);
  return out;
}

/** Conditions present in the items, most common first (for the filter menu). */
export function conditionOptions(items: GoldenItem[]): { value: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const it of items) for (const c of it.conditions) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, label: conditionLabel(value), count }));
}

// ── formatting ───────────────────────────────────────

/** 0.98872 -> '98.87' (percent, no sign). */
export function pct(x: number, digits = 2): string {
  return (x * 100).toFixed(digits);
}

export const fmtInt = (n: number) => n.toLocaleString('en-IN');

/** '2026-09-30T22:17:01+05:30' -> '30 Sept 2026, 10:17 pm IST'. */
export function fmtMeasuredAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || '—';
  return `${d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST`;
}

export function fmtMeasuredDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || '—';
  return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
}

export function shortHash(h: string, n = 12): string {
  return h ? h.slice(0, n) : '—';
}

/** Endpoint without the model-internal detail in brackets: 'POST /v1/ocr (live API, …)' -> 'POST /v1/ocr'. */
export function endpointPath(endpoint: string): string {
  return endpoint.replace(/\s*\(.*\)\s*$/, '').trim() || endpoint;
}

// ── insight figures ─────────────────────────────────

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Median confidence of correct vs wrong reads (low confidence flags most errors). */
export function confidenceSplit(items: GoldenItem[]): { correct: number | null; wrong: number | null } {
  return {
    correct: median(items.filter((i) => i.correct).map((i) => i.confidence)),
    wrong: median(items.filter((i) => !i.correct).map((i) => i.confidence)),
  };
}

/** Fewest labellers on any scored plate. */
export function minLabelers(items: GoldenItem[]): number {
  return items.reduce((m, i) => Math.min(m, i.labelers), Number.POSITIVE_INFINITY) || 0;
}

/** Colour band of a model confidence (0–100). */
export function confidenceTone(c: number): 'success' | 'warning' | 'danger' {
  return c >= 90 ? 'success' : c >= 75 ? 'warning' : 'danger';
}
