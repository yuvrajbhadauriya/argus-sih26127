import { describe, expect, it } from 'vitest';
import { diffMarks } from './diff';

describe('diffMarks', () => {
  it('is empty for an exact match', () => {
    const m = diffMarks('MH01AB1234', 'MH01AB1234');
    expect(m.gt.size + m.pred.size).toBe(0);
  });

  it('marks substitutions on both sides', () => {
    const m = diffMarks('DL9CAU8026', 'DL9C4U8026');
    expect([...m.gt]).toEqual([4]);
    expect([...m.pred]).toEqual([4]);
  });

  it('marks transposed digits', () => {
    const m = diffMarks('HR16AD3073', 'HR16AD3307');
    expect(m.gt.size).toBeGreaterThan(0);
    expect(Math.min(...m.pred)).toBeGreaterThanOrEqual(6);
  });

  it('marks a dropped character in the label and an extra one in the read', () => {
    expect([...diffMarks('AB123', 'AB12').gt]).toEqual([4]);
    expect([...diffMarks('AB12', 'AB123').pred]).toEqual([4]);
  });
});
