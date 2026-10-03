// ═══════════════════════════════════════════════════
// Eval results schema (public/eval/results.json, schema_version 1) and the
// optional video-consistency file. Written by pipeline/eval/evaluate.py and
// pipeline/eval/video_consistency.py. The parser is defensive: unknown fields
// are ignored, missing metrics become null, a wrong schema version throws.
// ═══════════════════════════════════════════════════

export const SUPPORTED_SCHEMA = 1;

export type EvalStatus = 'sample' | 'measured';

export interface Latency {
  n: number;
  p50: number | null;
  p95: number | null;
  mean: number | null;
}

export interface MetricBlock {
  images: number;
  plates: number;
  detected: number;
  exact: number;
  lenient_exact: number;
  false_reads: number;
  api_errors: number;
  plate_accuracy: number | null;
  lenient_accuracy: number | null;
  ocr_accuracy: number | null;
  char_accuracy: number | null;
  detection_recall: number | null;
  plate_miss_rate: number | null;
  read_precision: number | null;
  latency_ms: Latency;
  inference_ms: Latency;
}

export interface DatasetRow extends MetricBlock {
  id: string;
  name: string;
  source_url: string;
  license: string;
  kind: string;
  notes: string;
}

export interface ConditionRow extends MetricBlock {
  condition: string;
  source: 'label' | 'heuristic' | 'mixed';
}

export interface SamplePrediction {
  id: string;
  dataset: string;
  gt: string;
  pred: string | null;
  correct: boolean;
  lenient_correct: boolean;
  edits: number;
  confidence: number | null;
  conditions: string[];
  thumb: string | null;
}

/** The deployed model as described by the model team (context, not this harness's measurement). */
export interface ModelCardInfo {
  engine: string | null;
  model_version: string | null;
  detector: string | null;
  ocr: string | null;
  hardware: string | null;
  reported: { metric: string; value: number | null; value_ms: number | null; scope: string }[];
  reported_note: string;
}

export interface EvalResults {
  schema_version: number;
  status: EvalStatus;
  note: string;
  generated_at: string | null;
  duration_s: number | null;
  target: { plate_accuracy: number; metric: string; source: string };
  model: { engine: string | null; model_version: string | null; api: string; source: string | null };
  model_card: ModelCardInfo | null;
  config: Record<string, string | number>;
  overall: MetricBlock;
  per_dataset: DatasetRow[];
  per_condition: ConditionRow[];
  confusions: { gt: string; pred: string; count: number }[];
  samples: SamplePrediction[];
  skipped: { id: string; reason: string }[];
}

export class EvalSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalSchemaError';
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v: unknown): number => num(v) ?? 0;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const rate = (v: unknown): number | null => {
  const n = num(v);
  return n == null ? null : Math.min(1, Math.max(0, n));
};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function latency(v: unknown): Latency {
  const o = isObj(v) ? v : {};
  return { n: int(o.n), p50: num(o.p50), p95: num(o.p95), mean: num(o.mean) };
}

function block(v: unknown): MetricBlock {
  const o = isObj(v) ? v : {};
  return {
    images: int(o.images),
    plates: int(o.plates),
    detected: int(o.detected),
    exact: int(o.exact),
    lenient_exact: int(o.lenient_exact),
    false_reads: int(o.false_reads),
    api_errors: int(o.api_errors),
    plate_accuracy: rate(o.plate_accuracy),
    lenient_accuracy: rate(o.lenient_accuracy),
    ocr_accuracy: rate(o.ocr_accuracy),
    char_accuracy: rate(o.char_accuracy),
    detection_recall: rate(o.detection_recall),
    plate_miss_rate: rate(o.plate_miss_rate) ?? (rate(o.detection_recall) == null ? null : 1 - rate(o.detection_recall)!),
    read_precision: rate(o.read_precision),
    latency_ms: latency(o.latency_ms),
    inference_ms: latency(o.inference_ms),
  };
}

export function parseEvalResults(raw: unknown): EvalResults {
  if (!isObj(raw)) throw new EvalSchemaError('results.json is not a JSON object');
  if (raw.schema_version !== SUPPORTED_SCHEMA) {
    throw new EvalSchemaError(`Unsupported results schema_version ${String(raw.schema_version)} (expected ${SUPPORTED_SCHEMA})`);
  }
  if (!isObj(raw.overall)) throw new EvalSchemaError('results.json has no "overall" block');
  // Anything that is not explicitly "measured" is treated as sample data — never shown as a real result.
  const status: EvalStatus = raw.status === 'measured' ? 'measured' : 'sample';
  const target = isObj(raw.target) ? raw.target : {};
  const model = isObj(raw.model) ? raw.model : {};
  const config: Record<string, string | number> = {};
  if (isObj(raw.config)) {
    for (const [k, v] of Object.entries(raw.config)) if (typeof v === 'string' || typeof v === 'number') config[k] = v;
  }
  return {
    schema_version: SUPPORTED_SCHEMA,
    status,
    note: str(raw.note) ?? '',
    generated_at: str(raw.generated_at),
    duration_s: num(raw.duration_s),
    target: {
      plate_accuracy: rate(target.plate_accuracy) ?? 0.9,
      metric: str(target.metric) ?? 'plate_accuracy',
      source: str(target.source) ?? 'BEL PS SIH26127',
    },
    model: {
      engine: str(model.engine),
      model_version: str(model.model_version),
      api: str(model.api) ?? 'unknown',
      source: str(model.source),
    },
    model_card: isObj(raw.model_card)
      ? {
          engine: str(raw.model_card.engine),
          model_version: str(raw.model_card.model_version),
          detector: str(raw.model_card.detector),
          ocr: str(raw.model_card.ocr),
          hardware: str(raw.model_card.hardware),
          reported: arr(raw.model_card.reported).filter(isObj).filter((b) => str(b.metric)).map((b) => ({
            metric: str(b.metric)!,
            value: rate(b.value),
            value_ms: num(b.value_ms),
            scope: str(b.scope) ?? '',
          })),
          reported_note: str(raw.model_card.reported_note) ?? 'Reported by the model team; not measured by this harness.',
        }
      : null,
    config,
    overall: block(raw.overall),
    per_dataset: arr(raw.per_dataset).filter(isObj).map((d) => ({
      ...block(d),
      id: str(d.id) ?? 'unknown',
      name: str(d.name) ?? str(d.id) ?? 'Unknown dataset',
      source_url: str(d.source_url) ?? '',
      license: str(d.license) ?? '—',
      kind: str(d.kind) ?? '',
      notes: str(d.notes) ?? '',
    })),
    per_condition: arr(raw.per_condition).filter(isObj).filter((c) => str(c.condition)).map((c) => ({
      ...block(c),
      condition: str(c.condition)!,
      source: c.source === 'label' || c.source === 'heuristic' ? c.source : 'mixed',
    })),
    confusions: arr(raw.confusions).filter(isObj).map((c) => ({
      gt: typeof c.gt === 'string' ? c.gt : '',
      pred: typeof c.pred === 'string' ? c.pred : '',
      count: int(c.count),
    })).filter((c) => c.count > 0),
    samples: arr(raw.samples).filter(isObj).filter((s) => str(s.gt)).map((s) => ({
      id: str(s.id) ?? '',
      dataset: str(s.dataset) ?? '',
      gt: str(s.gt)!,
      pred: str(s.pred),
      correct: s.correct === true,
      lenient_correct: s.lenient_correct === true,
      edits: int(s.edits),
      confidence: rate(s.confidence),
      conditions: arr(s.conditions).filter((c): c is string => typeof c === 'string'),
      // Only same-origin eval thumbnails are rendered.
      thumb: typeof s.thumb === 'string' && /^\/eval\/samples\/[\w.-]+$/.test(s.thumb) ? s.thumb : null,
    })),
    skipped: arr(raw.skipped).filter(isObj).map((s) => ({ id: str(s.id) ?? '', reason: str(s.reason) ?? '' })),
  };
}

// ── Formatting ────────────────────────────────────────────────────────
export const fmtPct = (v: number | null, digits = 1) => (v == null ? '—' : `${(v * 100).toFixed(digits)}%`);

/** Character-level diff for the gallery: ops aligned GT vs prediction. */
export type DiffOp = { kind: 'eq' | 'sub' | 'del' | 'ins'; gt: string; pred: string };

export function plateDiff(gt: string, pred: string): DiffOp[] {
  const n = gt.length;
  const m = pred.length;
  const d: number[][] = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (gt[i - 1] === pred[j - 1] ? 0 : 1));
    }
  }
  const ops: DiffOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (gt[i - 1] === pred[j - 1] ? 0 : 1)) {
      ops.push({ kind: gt[i - 1] === pred[j - 1] ? 'eq' : 'sub', gt: gt[i - 1], pred: pred[j - 1] });
      i--;
      j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      ops.push({ kind: 'del', gt: gt[i - 1], pred: '' });
      i--;
    } else {
      ops.push({ kind: 'ins', gt: '', pred: pred[j - 1] });
      j--;
    }
  }
  return ops.reverse();
}

