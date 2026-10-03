import { describe, it, expect } from 'vitest';
import { containsModelName, redactModelNames } from './publicCopy';

describe('redactModelNames', () => {
  it.each([
    'DEIM (deim50k) — vehicle + plate detection',
    'PARSeq (raw35) — plate text recognition',
    'End-to-end, deim50k + ocr_v9 (previous OCR)',
    'deim50k+raw35 end-to-end accuracy',
    'yolov7-tiny-anpr',
    'engine lpu_on_gpu',
  ])('removes names from %j', (s) => {
    const out = redactModelNames(s);
    expect(containsModelName(out)).toBe(false);
    expect(out).not.toMatch(/deim|parseq|raw35|yolo|ocr_v9/i);
  });
  it('leaves ordinary text alone', () => {
    expect(redactModelNames('OCR latency per crop')).toBe('OCR latency per crop');
  });
});
