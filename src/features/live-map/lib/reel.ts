// ═══════════════════════════════════════════════════
// The Live feed reel: a deterministic, seeded, never-ending replay of RECORDED
// reads. Time is cut into slots of REEL_INTERVAL_MS; slot n always holds the same
// row for everyone:
//   · a camera slot: one recorded good read of one of ALL cameras, the cameras
//     taking turns in a seeded shuffled order per round (no camera starves, the
//     order never looks mechanical), each camera walking its own reads in a
//     seeded shuffled order;
//   · or a golden-set slot (GOLDEN_SHARE of the slots): a golden-set plate drawn
//     with replacement from ALL scored plates, so the model's real mistakes show
//     up at their natural rate.
// Nothing here is generated: every row points at a recorded event or a golden-set item.
// ═══════════════════════════════════════════════════

import { goodReads } from '@/features/detections/lib/liveReads';
import type { CameraEvents, PlateEvent } from '@/features/detections/api';
import type { GoldenItem } from '@/features/golden-set/lib/results';
import type { LiveFeedEntry } from '@/mocks/fixtures/mockLiveFeed';

export const REEL_SEED = 'argus-live-feed-v1';
export const REEL_INTERVAL_MS = 3000;
/** Share of the slots that hold a golden-set plate (when the golden set is available). */
export const GOLDEN_SHARE = 0.25;

export type FeedFilter = 'all' | 'cameras' | 'golden';

export type ReelRow =
  | { kind: 'camera'; key: string; slot: number; at: number; camera_code: string; event: PlateEvent }
  | { kind: 'golden'; key: string; slot: number; at: number; itemIndex: number };

/** FNV-1a 32-bit string hash. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small seeded PRNG, uniform in [0, 1). */
export function seeded(seed: string): () => number {
  let a = hash32(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded Fisher–Yates; returns a new array. */
export function shuffled<T>(xs: readonly T[], seed: string): T[] {
  const out = [...xs];
  const rnd = seeded(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function isGoldenSlot(slot: number): boolean {
  return seeded(`${REEL_SEED}:kind:${slot}`)() < GOLDEN_SHARE;
}

const orderCache = new WeakMap<CameraEvents, number[]>();
function readOrder(cam: CameraEvents): number[] {
  let o = orderCache.get(cam);
  if (!o) {
    o = shuffled(goodReads(cam).map((_, i) => i), `${REEL_SEED}:reads:${cam.camera_code}`);
    orderCache.set(cam, o);
  }
  return o;
}

export interface ReelOptions {
  filter?: FeedFilter;
  /** Rows to return (newest first). */
  limit?: number;
  /** Number of scored golden-set plates (0 / omitted: no golden slots). */
  goldenCount?: number;
  /** Plate text of a golden-set plate (ground truth), used to keep equal plates from following each other. */
  goldenPlate?: (index: number) => string;
}

/** Slots swept before the first row shown, so a row does not depend on where the window starts (conflict chains are short). */
const WARMUP_SLOTS = 16;
const MAX_ATTEMPTS = 16;
const compact = (s: string | null | undefined) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Rows of the reel up to `nowMs`, newest first. Deterministic for a given (docs, nowMs, options).
 * The same plate never directly follows itself - neither in the full feed nor in the Cameras / Golden set
 * views: a slot whose pick repeats the plate of the previous slot (or of the previous slot of its own kind)
 * takes the next seeded alternative instead (rare with real data, where plates differ).
 */
export function reelRows(docs: CameraEvents[], nowMs: number, opts: ReelOptions = {}): ReelRow[] {
  const { filter = 'all', limit = 40, goldenCount = 0, goldenPlate } = opts;
  const cams = docs.filter((d) => goodReads(d).length > 0).sort((a, b) => a.camera_code.localeCompare(b.camera_code));
  const wantCameras = filter !== 'golden' && cams.length > 0;
  const wantGolden = filter !== 'cameras' && goldenCount > 0;
  if (limit <= 0 || (!wantCameras && !wantGolden)) return [];

  // A golden slot is a camera slot when there is no golden set, and vice versa.
  const slotIsGolden = (slot: number) => goldenCount > 0 && (cams.length === 0 || isGoldenSlot(slot));

  const candidate = (slot: number, attempt: number): ReelRow => {
    const at = slot * REEL_INTERVAL_MS;
    if (slotIsGolden(slot)) {
      const itemIndex = Math.floor(seeded(`${REEL_SEED}:golden:${slot}${attempt ? `:${attempt}` : ''}`)() * goldenCount);
      return { kind: 'golden', key: `golden-${slot}`, slot, at, itemIndex };
    }
    const round = Math.floor(slot / cams.length);
    const order = shuffled(cams.map((_, i) => i), `${REEL_SEED}:round:${round}`);
    const cam = cams[order[(slot + attempt) % cams.length]];
    const reads = goodReads(cam);
    const event = reads[readOrder(cam)[(round + attempt) % reads.length]];
    return { kind: 'camera', key: `${cam.camera_code}-${slot}-${event.tracked_vehicle_id}`, slot, at, camera_code: cam.camera_code, event };
  };
  const plateOf = (r: ReelRow) => compact(r.kind === 'camera' ? r.event.plate_text : goldenPlate?.(r.itemIndex));

  // Which slots are needed: walk back from the newest until `limit` wanted rows are covered.
  const newest = Math.floor(nowMs / REEL_INTERVAL_MS);
  let oldest = newest;
  for (let slot = newest, n = 0; slot > newest - limit * 12 && n < limit; slot--) {
    oldest = slot;
    if (slotIsGolden(slot) ? wantGolden : wantCameras) n++;
  }

  // Sweep forward (from a short warm-up before `oldest`) so every row is chosen against the row before it
  // and the previous row of its own kind - the rows that actually sit next to it in the All / Cameras / Golden views.
  const rows = new Map<number, ReelRow>();
  const lastOfKind = { golden: '', camera: '' };
  let prev = '';
  for (let slot = oldest - WARMUP_SLOTS; slot <= newest; slot++) {
    const kind = slotIsGolden(slot) ? 'golden' : 'camera';
    let row = candidate(slot, 0);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const c = attempt === 0 ? row : candidate(slot, attempt);
      const p = plateOf(c);
      if (!p || (p !== prev && p !== lastOfKind[kind])) {
        row = c;
        break;
      }
    }
    rows.set(slot, row);
    prev = plateOf(row);
    lastOfKind[kind] = prev;
  }

  const out: ReelRow[] = [];
  for (let slot = newest; slot >= oldest; slot--) {
    if (slotIsGolden(slot) ? wantGolden : wantCameras) out.push(rows.get(slot)!);
  }
  return out.slice(0, limit);
}

/** A golden-set plate in the feed: NOT a camera read (no camera, no time). */
export interface GoldenFeedEntry {
  kind: 'golden';
  id: string;
  item: GoldenItem;
}

export type FeedEntry = LiveFeedEntry | GoldenFeedEntry;

export const isGoldenEntry = (e: FeedEntry): e is GoldenFeedEntry => 'kind' in e && e.kind === 'golden';
