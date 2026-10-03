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
}

/** The camera whose turn slot `slot` is, and which of its reads it replays. */
function cameraSlot(cams: CameraEvents[], slot: number): { cam: CameraEvents; event: PlateEvent } {
  const round = Math.floor(slot / cams.length);
  const order = shuffled(cams.map((_, i) => i), `${REEL_SEED}:round:${round}`);
  const cam = cams[order[slot % cams.length]];
  const reads = goodReads(cam);
  return { cam, event: reads[readOrder(cam)[round % reads.length]] };
}

/** Rows of the reel up to `nowMs`, newest first. Deterministic for a given (docs, nowMs, options). */
export function reelRows(docs: CameraEvents[], nowMs: number, opts: ReelOptions = {}): ReelRow[] {
  const { filter = 'all', limit = 40, goldenCount = 0 } = opts;
  const cams = docs.filter((d) => goodReads(d).length > 0).sort((a, b) => a.camera_code.localeCompare(b.camera_code));
  const wantCameras = filter !== 'golden' && cams.length > 0;
  const wantGolden = filter !== 'cameras' && goldenCount > 0;
  if (limit <= 0 || (!wantCameras && !wantGolden)) return [];
  const out: ReelRow[] = [];
  const newest = Math.floor(nowMs / REEL_INTERVAL_MS);
  for (let slot = newest; slot > newest - limit * 12 && out.length < limit; slot--) {
    // A golden slot falls back to a camera slot when there is no golden set, and vice versa.
    const golden = goldenCount > 0 && (cams.length === 0 || isGoldenSlot(slot));
    const at = slot * REEL_INTERVAL_MS;
    if (golden) {
      if (!wantGolden) continue;
      const itemIndex = Math.floor(seeded(`${REEL_SEED}:golden:${slot}`)() * goldenCount);
      out.push({ kind: 'golden', key: `golden-${slot}`, slot, at, itemIndex });
    } else {
      if (!wantCameras) continue;
      const { cam, event } = cameraSlot(cams, slot);
      out.push({ kind: 'camera', key: `${cam.camera_code}-${slot}-${event.tracked_vehicle_id}`, slot, at, camera_code: cam.camera_code, event });
    }
  }
  return out;
}

/** A golden-set plate in the feed: NOT a camera read (no camera, no time). */
export interface GoldenFeedEntry {
  kind: 'golden';
  id: string;
  item: GoldenItem;
}

export type FeedEntry = LiveFeedEntry | GoldenFeedEntry;

export const isGoldenEntry = (e: FeedEntry): e is GoldenFeedEntry => 'kind' in e && e.kind === 'golden';
