// ═══════════════════════════════════════════════════
// Route table — every page is its own lazily loaded chunk, so the first visit
// only downloads the shell + the page being opened (Leaflet only ships with
// the map pages).
// ═══════════════════════════════════════════════════

import { lazyPage } from './lazyPage';

export const pages = {
  liveMap: lazyPage(() => import('@/features/live-map/pages/LiveMapPage'), 'LiveMapPage'),
  cameras: lazyPage(() => import('@/features/cameras/pages/CamerasPage'), 'CamerasPage'),
  vehicles: lazyPage(() => import('@/features/vehicles/pages/VehiclesPage'), 'VehiclesPage'),
  alerts: lazyPage(() => import('@/features/alerts/pages/AlertsPage'), 'AlertsPage'),
  analytics: lazyPage(() => import('@/features/analytics/pages/AnalyticsPage'), 'AnalyticsPage'),
  detections: lazyPage(() => import('@/features/detections/pages/DetectionsPage'), 'DetectionsPage'),
  admin: lazyPage(() => import('@/features/admin/pages/AdminPage'), 'AdminPage'),
  login: lazyPage(() => import('@/features/auth/LoginPage'), 'LoginPage'),
};

/** Operator sign-in — rendered outside the dashboard shell (see App.tsx). */
export const loginRoute = { path: '/login', page: pages.login } as const;

export const routes = [
  { path: '/', page: pages.liveMap },
  { path: '/cameras', page: pages.cameras },
  { path: '/vehicles', page: pages.vehicles },
  { path: '/alerts', page: pages.alerts },
  { path: '/analytics', page: pages.analytics },
  { path: '/accuracy', page: lazyPage(() => import('@/features/golden-set/pages/AccuracyProofPage'), 'AccuracyProofPage') },
  { path: '/model', page: lazyPage(() => import('@/features/model-performance/pages/ModelPerformancePage'), 'ModelPerformancePage') },
  { path: '/detections', page: pages.detections },
  { path: '/admin', page: pages.admin },
] as const;

/** Normalised pathname → route (matches the build-time preload map in vite.config.ts). */
export function findRoute(pathname: string) {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === loginRoute.path) return loginRoute;
  return routes.find((r) => r.path === p);
}

/**
 * After the first page is interactive, quietly fetch the other route chunks
 * (small) so later navigation never waits on the network.
 */
export function prefetchRoutesWhenIdle(): () => void {
  if (typeof window === 'undefined') return () => {};
  // Respect data-saver / very slow connections.
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (conn?.saveData || conn?.effectiveType === '2g' || conn?.effectiveType === 'slow-2g') return () => {};

  const run = () => {
    for (const r of routes) void r.page.preload();
  };
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  if (w.requestIdleCallback) {
    const id = w.requestIdleCallback(run, { timeout: 4000 });
    return () => w.cancelIdleCallback?.(id);
  }
  const t = window.setTimeout(run, 2500);
  return () => window.clearTimeout(t);
}
