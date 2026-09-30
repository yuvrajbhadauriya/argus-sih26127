// Video-wall streaming policy.

/** Wall tiles stream only on wide screens without data saver. */
export function canStreamWall(): boolean {
  try {
    const conn = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    if (conn?.saveData || conn?.effectiveType === '2g' || conn?.effectiveType === 'slow-2g') return false;
    return typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 768px)').matches;
  } catch {
    return false;
  }
}
