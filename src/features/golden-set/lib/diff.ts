// Character positions that differ between the human label and the model's
// read (edit-distance alignment), for highlighting on both plates.

import { plateDiff } from '@/features/model-performance/lib/results';

export interface DiffMarks {
  /** Indices in the label that were misread or missed. */
  gt: Set<number>;
  /** Indices in the read that are wrong or extra. */
  pred: Set<number>;
}

export function diffMarks(gt: string, pred: string): DiffMarks {
  const marks: DiffMarks = { gt: new Set(), pred: new Set() };
  if (gt === pred) return marks;
  let i = 0;
  let j = 0;
  for (const op of plateDiff(gt, pred)) {
    if (op.kind === 'eq') {
      i++;
      j++;
    } else if (op.kind === 'sub') {
      marks.gt.add(i++);
      marks.pred.add(j++);
    } else if (op.kind === 'del') {
      marks.gt.add(i++);
    } else {
      marks.pred.add(j++);
    }
  }
  return marks;
}
