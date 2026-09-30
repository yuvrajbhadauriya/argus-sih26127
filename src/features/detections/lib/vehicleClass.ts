const LABELS: Record<string, string> = { car: 'Car', truck: 'Truck', bus: 'Bus', motorcycle: 'Motorcycle' };

/** Display label for a vehicle class ("motorcycle" → "Motorcycle"). */
export function vehicleClassLabel(t: string): string {
  return LABELS[(t || '').toLowerCase()] ?? (t ? t[0].toUpperCase() + t.slice(1) : 'Unknown');
}
