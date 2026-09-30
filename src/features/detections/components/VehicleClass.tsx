// Vehicle class icon + label, shared by the Live Map, Cameras and Detections screens.
import { vehicleClassLabel } from '../lib/vehicleClass';
import { BikeIcon, BusIcon, CarIcon, CircleHelpIcon, TruckIcon, type LucideIcon } from 'lucide-react';

const ICONS: Record<string, LucideIcon> = { car: CarIcon, truck: TruckIcon, bus: BusIcon, motorcycle: BikeIcon };

export function VehicleClassIcon({ type, size = 14, className }: { type: string; size?: number; className?: string }) {
  const Icon = ICONS[(type || '').toLowerCase()] ?? CircleHelpIcon;
  return <Icon size={size} strokeWidth={1.75} aria-hidden="true" className={className} />;
}

/** Icon followed by the class name. */
export function VehicleClass({ type, iconOnly = false, className = '' }: { type: string; iconOnly?: boolean; className?: string }) {
  const label = vehicleClassLabel(type);
  return (
    <span className={`inline-flex items-center gap-1.5 text-fg-muted ${className}`} title={iconOnly ? label : undefined}>
      <VehicleClassIcon type={type} />
      {iconOnly ? <span className="sr-only">{label}</span> : <span className="text-fg">{label}</span>}
    </span>
  );
}
