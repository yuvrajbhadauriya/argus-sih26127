// Single source of truth for the primary navigation (desktop Sidebar,
// phone BottomNav and its "More" sheet).

import {
  BadgeCheckIcon,
  CctvIcon,
  ChartColumnIcon,
  MapIcon,
  RouteIcon,
  ScanLineIcon,
  ScanTextIcon,
  SettingsIcon,
  SirenIcon,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  path: string;
  label: string;
  Icon: LucideIcon;
  badge?: 'alerts';
}

export const NAV_GROUPS: { heading: string; items: NavItem[] }[] = [
  {
    heading: 'Operations',
    items: [
      { path: '/', label: 'Live Map', Icon: MapIcon },
      { path: '/cameras', label: 'Cameras', Icon: CctvIcon },
      { path: '/alerts', label: 'Alerts', Icon: SirenIcon, badge: 'alerts' },
    ],
  },
  {
    heading: 'Investigation',
    items: [
      { path: '/vehicles', label: 'Vehicle Trace', Icon: RouteIcon },
      { path: '/detections', label: 'Detections', Icon: ScanLineIcon },
    ],
  },
  {
    heading: 'Intelligence',
    items: [
      { path: '/accuracy', label: 'Accuracy Proof', Icon: BadgeCheckIcon },
      { path: '/analytics', label: 'Analytics', Icon: ChartColumnIcon },
      { path: '/model', label: 'Model Performance', Icon: ScanTextIcon },
    ],
  },
  { heading: 'System', items: [{ path: '/admin', label: 'Admin', Icon: SettingsIcon }] },
];

const byPath = new Map(NAV_GROUPS.flatMap((g) => g.items).map((i) => [i.path, i]));
const pick = (paths: string[]) => paths.map((p) => byPath.get(p)!);

/** Bottom tab bar (phones): the four most-used screens. Everything else is under "More". */
export const BOTTOM_TABS: NavItem[] = pick(['/', '/cameras', '/alerts', '/detections']);
export const MORE_ITEMS: NavItem[] = pick(['/vehicles', '/accuracy', '/analytics', '/model', '/admin']);
