import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EvalSchemaError, fmtPct, parseEvalResults, parseVideoConsistency, plateDiff, verdict } from './results';

const read = (p: string) => JSON.parse(readFileSync(resolve(process.cwd(), p), 'utf8'));
// Mock-run output (pipeline/eval/evaluate.py --mock) and whatever is currently published.
const sample = read('src/features/model-performance/__fixtures__/sample-results.json');
const sampleVideo = read('src/features/model-performance/__fixtures__/sample-video.json');
const published = read('public/eval/results.json');
const publishedVideo = read('public/eval/video_consistency.json');

const minimal = (over: Record<string, unknown> = {}) => ({
  schema_version: 1,
  status: 'measured',
  overall: { images: 10, plates: 10, detected: 10, exact: 9, plate_accuracy: 0.9, char_accuracy: 0.97, latency_ms: { n: 10, p50: 80, p95: 120 } },
  target: { plate_accuracy: 0.9 },
  ...over,
});

describe('parseEvalResults', () => {
  it('parses the published results file', () => {
    const r = parseEvalResults(published);
    expect(['sample', 'measured']).toContain(r.status);
    expect(r.overall.plates).toBeGreaterThan(0);
    expect(r.model_card?.model_version).toBe('deim50k+raw35');
    expect(parseVideoConsistency(publishedVideo).per_camera.length).toBeGreaterThan(0);
  });

  it('parses a mock-run file and keeps it labelled as sample', () => {
    const r = parseEvalResults(sample);
    expect(r.status).toBe('sample');
    expect(r.note).toMatch(/evaluate\.py/);
    expect(r.overall.plates).toBeGreaterThan(0);
    expect(r.per_dataset.length).toBeGreaterThan(0);
    expect(r.per_condition.every((c) => ['label', 'heuristic', 'mixed'].includes(c.source))).toBe(true);
    expect(verdict(r)).toBe('not-measured'); // sample data never gets pass/fail
  });

  it('rejects wrong schema versions and non-objects', () => {
    expect(() => parseEvalResults(null)).toThrow(EvalSchemaError);
    expect(() => parseEvalResults({ ...minimal(), schema_version: 2 })).toThrow(/schema_version 2/);
    expect(() => parseEvalResults({ schema_version: 1 })).toThrow(/overall/);
  });

  it('fills defaults, clamps rates and treats unknown status as sample', () => {
    const r = parseEvalResults(minimal({ status: 'final', overall: { plate_accuracy: 1.7, char_accuracy: 'x' }, target: undefined }));
    expect(r.status).toBe('sample');
    expect(r.overall.plate_accuracy).toBe(1);
    expect(r.overall.char_accuracy).toBeNull();
    expect(r.overall.latency_ms.p95).toBeNull();
    expect(r.target.plate_accuracy).toBe(0.9);
    expect(r.per_dataset).toEqual([]);
  });

  it('only allows same-origin sample thumbnails', () => {
    const r = parseEvalResults(minimal({
      samples: [
        { gt: 'MH01AB1234', pred: 'MH01AB1234', correct: true, thumb: '/eval/samples/00_a.jpg' },
        { gt: 'MH01AB1235', pred: null, correct: false, thumb: 'https://evil.example/x.jpg' },
        { gt: '', pred: 'X' },
      ],
    }));
    expect(r.samples.map((s) => s.thumb)).toEqual(['/eval/samples/00_a.jpg', null]);
  });

  it('verdict: pass at/above target, fail below, only when measured', () => {
    expect(verdict(parseEvalResults(minimal()))).toBe('pass');
    expect(verdict(parseEvalResults(minimal({ overall: { plates: 10, plate_accuracy: 0.899 } })))).toBe('fail');
    expect(verdict(parseEvalResults(minimal({ overall: { plates: 0, plate_accuracy: null } })))).toBe('not-measured');
  });
});

describe('parseVideoConsistency', () => {
  it('parses a mock-run file', () => {
    const v = parseVideoConsistency(sampleVideo);
    expect(v.status).toBe('sample');
    expect(v.per_camera.length).toBeGreaterThan(0);
    expect(v.overall.mean_stability).not.toBeNull();
  });
  it('throws on garbage', () => {
    expect(() => parseVideoConsistency({ schema_version: 1 })).toThrow(EvalSchemaError);
  });
});

describe('helpers', () => {
  it('plateDiff marks substitutions, deletions and insertions', () => {
    expect(plateDiff('MH02AB', 'MH02A8').map((o) => o.kind)).toEqual(['eq', 'eq', 'eq', 'eq', 'eq', 'sub']);
    expect(plateDiff('AB12', 'A12').filter((o) => o.kind === 'del')).toEqual([{ kind: 'del', gt: 'B', pred: '' }]);
    expect(plateDiff('A1', 'A12').at(-1)).toEqual({ kind: 'ins', gt: '', pred: '2' });
  });
  it('fmtPct', () => {
    expect(fmtPct(0.9123)).toBe('91.2%');
    expect(fmtPct(null)).toBe('—');
  });
});
