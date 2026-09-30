// Render-without-crashing smoke tests for every route, in mock-data mode
// (Supabase unconfigured in the test env). Leaflet and <video> players are
// stubbed because jsdom has no layout/canvas/media support.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { ReactNode } from 'react';

vi.mock('react-leaflet', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div data-testid="leaflet">{children}</div>;
  return {
    MapContainer: Pass, TileLayer: () => null, Marker: Pass, Popup: Pass, Tooltip: Pass,
    Polyline: () => null, CircleMarker: Pass, Circle: Pass, LayerGroup: Pass,
    useMap: () => ({ fitBounds: vi.fn(), setView: vi.fn(), flyTo: vi.fn(), invalidateSize: vi.fn() }),
  };
});
vi.mock('@/features/cameras/components/CameraVideoPlayer', () => ({ CameraVideoPlayer: () => <div data-testid="player" /> }));

import { DashboardLayout } from '@/shared/layout/DashboardLayout';
import { LiveMapPage } from '@/features/live-map/pages/LiveMapPage';
import { VehiclesPage } from '@/features/vehicles/pages/VehiclesPage';
import { AnalyticsPage } from '@/features/analytics/pages/AnalyticsPage';
import { AdminPage } from '@/features/admin/pages/AdminPage';
import { DetectionsPage } from '@/features/detections/pages/DetectionsPage';

const routes: [string, ReactNode][] = [
  ['/', <LiveMapPage key="map" />],
  ['/vehicles', <VehiclesPage key="veh" />],
  ['/analytics', <AnalyticsPage key="an" />],
  ['/admin', <AdminPage key="adm" />],
  ['/detections', <DetectionsPage key="det" />],
];

describe('route smoke tests (mock data mode)', () => {
  it.each(routes)('renders %s inside the dashboard layout', async (path, el) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve([]) })));
    const { container } = render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<DashboardLayout />}>
            <Route path={path} element={el} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    // layout nav is present and the page produced some content
    expect(screen.getAllByRole('link').length).toBeGreaterThan(0);
    expect(container.textContent!.length).toBeGreaterThan(50);
    vi.unstubAllGlobals();
  });
});
