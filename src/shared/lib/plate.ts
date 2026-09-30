// ═══════════════════════════════════════════════════
// Indian number-plate helpers (display formatting / normalisation)
// ═══════════════════════════════════════════════════

/** Uppercase alphanumerics only: 'dl-04 rs 9598' -> 'DL04RS9598'. */
export function normalizePlate(raw: string): string {
  return (raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const STANDARD = /^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{1,4})$/;
const BHARAT = /^(\d{2})(BH)(\d{4})([A-Z]{1,2})$/;

/**
 * Display format with HSRP spacing.
 * 'dl04rs9598' -> 'DL 04 RS 9598'; '22BH1234AA' -> '22 BH 1234 AA'; anything else -> trimmed uppercase.
 */
export function formatPlate(raw: string): string {
  const n = normalizePlate(raw);
  const bh = BHARAT.exec(n);
  if (bh) return `${bh[1]} ${bh[2]} ${bh[3]} ${bh[4]}`;
  const m = STANDARD.exec(n);
  if (m) return [m[1], m[2].padStart(2, '0'), m[3], m[4]].filter(Boolean).join(' ');
  return (raw ?? '').trim().toUpperCase();
}

export type PlateVariant = 'private' | 'commercial' | 'ev';

/** Vehicle class -> plate colour: trucks and buses carry commercial (yellow) plates. */
export function vehicleClassToPlateVariant(t: string): 'private' | 'commercial' {
  const v = (t ?? '').toLowerCase();
  return v === 'truck' || v === 'bus' ? 'commercial' : 'private';
}
