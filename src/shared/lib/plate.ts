// ═══════════════════════════════════════════════════
// Indian number-plate helpers (display formatting / normalisation)
// ═══════════════════════════════════════════════════

/** Uppercase alphanumerics only: 'mh-01 cs 0126' -> 'MH01CS0126'. */
export function normalizePlate(raw: string): string {
  return (raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const STANDARD = /^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{1,4})$/;
const BHARAT = /^(\d{2})(BH)(\d{4})([A-Z]{1,2})$/;

/**
 * Display format with HSRP spacing.
 * 'mh01cs0126' -> 'MH 01 CS 0126'; '22BH1234AA' -> '22 BH 1234 AA'; anything else -> trimmed uppercase.
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

/** Plate colour of a vehicle: its known colour, else derived from the class. */
export function plateVariantOf(v: { vehicle_type: string; plate_variant?: PlateVariant }): PlateVariant {
  return v.plate_variant ?? vehicleClassToPlateVariant(v.vehicle_type);
}

/** Vehicle class -> plate colour: trucks and buses carry commercial (yellow) plates. */
export function vehicleClassToPlateVariant(t: string): 'private' | 'commercial' {
  const v = (t ?? '').toLowerCase();
  return v === 'truck' || v === 'bus' ? 'commercial' : 'private';
}
