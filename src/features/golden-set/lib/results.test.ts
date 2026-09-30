import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeBreakdown,
  conditionOptions,
  DEFAULT_FILTERS,
  endpointPath,
  filterItems,
  fmtMeasuredAt,
  objectPath,
  otherGroups,
  parseGoldenResults,
  pct,
  plateVariant,
  summarize,
} from './results';
import { containsModelName } from '@/features/model-performance/lib/publicCopy';

const FIELDS = ['key', 'gt', 'pred', 'confidence', 'correct', 'grammar_valid', 'row_count', 'side', 'state_code', 'conditions', 'labelers', 'width', 'height', 'inference_ms', 'roundtrip_ms'];

const sample = {
  set: 'ocr_golden_v1',
  set_hash: 'abcdef0123456789',
  measured_at: '2026-09-30T22:17:01+05:30',
  endpoint: 'POST /v1/ocr (live API, plate crop, production grammar)',
  total_images: 5,
  scored: 3,
  skipped: { unreadable: 2 },
  overall: { n: 3, correct: 2, accuracy: 0.6667 },
  breakdown: { 'condition:day': { n: 2, correct: 1, accuracy: 0.5 }, 'condition:glare': { n: 1, correct: 1, accuracy: 1 } },
  latency_ms: { p50: 24.4, p95: 33.3 },
  bucket: 'golden',
  prefix: 'ocr_golden_v1',
  item_fields: FIELDS,
  items: [
    ['a', 'MH01AB1234', 'MH01AB1234', 99.1, 1, 1, 1, 'front', 'MH', ['day', 'hsrp-standard'], 2, 200, 45, 24, 26],
    ['b', 'DL9CAU8026', 'DL9C4U8026', 73.1, 0, 0, 2, 'rear', 'DL', ['day', 'green-ev'], 2, 120, 80, 30, 33],
    ['c', 'KA05MN0001', 'KA05MN0001', 88, 1, 1, 1, 'rear', 'KA', ['glare', 'commercial-yellow', 'clear'], 2, 190, 44, null, null],
  ],
};

describe('parseGoldenResults', () => {
  it('unpacks column-packed items and top-level fields', () => {
    const r = parseGoldenResults(sample);
    expect(r.items).toHaveLength(3);
    expect(r.items[1]).toMatchObject({ key: 'b', gt: 'DL9CAU8026', pred: 'DL9C4U8026', correct: false, rowCount: 2, side: 'rear', confidence: 73.1 });
    expect(r.items[2].conditions).toEqual(['glare', 'commercial-yellow']); // 'clear' dropped
    expect(r.items[2].inferenceMs).toBeNull();
    expect(r).toMatchObject({ unreadable: 2, totalImages: 5, scored: 3, latency: { p50: 24.4, p95: 33.3 } });
    expect(r.bucket).toBe('golden');
    expect(objectPath(r, r.items[0])).toBe('ocr_golden_v1/a.jpg');
  });

  it('also accepts object items', () => {
    const r = parseGoldenResults({ items: [{ key: 'k', gt: 'AB12', pred: 'AB12', conditions: ['day'] }] });
    expect(r.items[0].correct).toBe(true);
    expect(r.overall).toEqual({ n: 1, correct: 1, accuracy: 1 });
  });

  it('rejects files without items', () => {
    expect(() => parseGoldenResults(null)).toThrow();
    expect(() => parseGoldenResults({ items: [] })).toThrow(/no scored items/);
    expect(() => parseGoldenResults({ overall: {} })).toThrow(/missing items/);
  });
});

describe('aggregations and filters', () => {
  const r = parseGoldenResults(sample);

  it('summarize and computeBreakdown count correct reads per group', () => {
    expect(summarize(r.items)).toEqual({ n: 3, correct: 2, accuracy: 2 / 3 });
    const b = computeBreakdown(r.items);
    expect(b['condition:day']).toEqual({ n: 2, correct: 1, accuracy: 0.5 });
    expect(b['rows:2']).toEqual({ n: 1, correct: 0, accuracy: 0 });
    expect(b['side:rear']).toEqual({ n: 2, correct: 1, accuracy: 0.5 });
  });

  it('filters by query, condition, rows, side, result and confidence band', () => {
    const f = DEFAULT_FILTERS;
    expect(filterItems(r.items, f)).toHaveLength(3);
    expect(filterItems(r.items, { ...f, query: 'dl 9c' }).map((i) => i.key)).toEqual(['b']);
    expect(filterItems(r.items, { ...f, query: '4U80' }).map((i) => i.key)).toEqual(['b']); // matches the read too
    expect(filterItems(r.items, { ...f, condition: 'glare' }).map((i) => i.key)).toEqual(['c']);
    expect(filterItems(r.items, { ...f, rows: '2' }).map((i) => i.key)).toEqual(['b']);
    expect(filterItems(r.items, { ...f, side: 'front' }).map((i) => i.key)).toEqual(['a']);
    expect(filterItems(r.items, { ...f, result: 'wrong' }).map((i) => i.key)).toEqual(['b']);
    expect(filterItems(r.items, { ...f, result: 'correct' })).toHaveLength(2);
    expect(filterItems(r.items, { ...f, confidence: 'ge90' }).map((i) => i.key)).toEqual(['a']);
    expect(filterItems(r.items, { ...f, confidence: '75to90' }).map((i) => i.key)).toEqual(['c']);
    expect(filterItems(r.items, { ...f, confidence: 'lt75' }).map((i) => i.key)).toEqual(['b']);
    expect(filterItems(r.items, { ...f, sort: 'confidence-asc' }).map((i) => i.key)).toEqual(['b', 'c', 'a']);
  });

  it('condition options, small groups, plate colour', () => {
    expect(conditionOptions(r.items)[0]).toMatchObject({ value: 'day', count: 2, label: 'Daylight' });
    expect(otherGroups(r).map((g) => g.key)).toEqual(['condition:glare']);
    expect(plateVariant(r.items[1])).toBe('ev');
    expect(plateVariant(r.items[2])).toBe('commercial');
    expect(plateVariant(r.items[0])).toBe('private');
  });

  it('formats', () => {
    expect(pct(1403 / 1419)).toBe('98.87');
    expect(fmtMeasuredAt('2026-09-30T22:17:01+05:30')).toMatch(/30 Sept? 2026.*10:17.*pm IST/i);
    expect(endpointPath(sample.endpoint)).toBe('POST /v1/ocr');
  });
});

describe('published file public/golden/results_golden_v1.json', () => {
  const raw = JSON.parse(readFileSync(resolve(process.cwd(), 'public/golden/results_golden_v1.json'), 'utf8'));
  const r = parseGoldenResults(raw);

  it('is self-consistent: overall and every breakdown group match the items', () => {
    expect(summarize(r.items)).toMatchObject({ n: r.overall.n, correct: r.overall.correct });
    expect(r.items).toHaveLength(r.scored);
    expect(r.scored + r.unreadable).toBe(r.totalImages);
    const b = computeBreakdown(r.items);
    for (const [k, t] of Object.entries(r.breakdown)) {
      if (k === 'condition:clear') continue;
      expect(b[k], k).toMatchObject({ n: t.n, correct: t.correct });
    }
  });

  it('points at the private golden bucket (no public URLs) and never names model internals', () => {
    expect(r.bucket).toBe('golden');
    expect(r.prefix).toBe('ocr_golden_v1/');
    expect(JSON.stringify(raw)).not.toMatch(/https?:\/\//);
    expect(raw.image_base).toBeUndefined();
    expect(containsModelName(JSON.stringify(raw))).toBe(false);
    expect(raw.model_version).toBeUndefined();
  });
});

describe('insight figures', () => {
  it('median, confidence split and min labellers', async () => {
    const { median, confidenceSplit, minLabelers } = await import('./results');
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    const r = parseGoldenResults(sample);
    expect(confidenceSplit(r.items)).toEqual({ correct: (99.1 + 88) / 2, wrong: 73.1 });
    expect(minLabelers(r.items)).toBe(2);
  });
});
