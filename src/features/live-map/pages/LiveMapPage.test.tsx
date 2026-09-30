// LiveMapPage: KPIs from the sim summary + alerts, rail tabs, ?cam= selection.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { useEffect, type ReactNode } from 'react';
import type { Camera } from '@/types/camera';

const h = vi.hoisted(() => ({ flyTo: vi.fn(), fitBounds: vi.fn(), getCameras: vi.fn(), fetchAlerts: vi.fn() }));

vi.mock('react-leaflet', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div data-testid="leaflet">{children}</div>;
  return {
    MapContainer: Pass, TileLayer: () => null, Marker: ({ children, title }: { children?: ReactNode; title?: string }) => <div data-testid="marker" title={title}>{children}</div>,
    Popup: Pass, Tooltip: Pass, CircleMarker: () => <div data-testid="hotspot" />,
    useMap: () => ({ fitBounds: h.fitBounds, setView: vi.fn(), flyTo: h.flyTo, getZoom: () => 12 }),
  };
});
vi.mock('@/features/cameras/api', () => ({ getCameras: h.getCameras }));
vi.mock('@/features/alerts/api', () => ({ fetchAlerts: h.fetchAlerts }));

import { LiveMapPage } from './LiveMapPage';
import { clearCamerasCache } from '@/features/cameras/hooks/useCameras';
import { clearSimSummaryCache } from '../api';

const cam = (over: Partial<Camera>): Camera => ({
  id: 'cam-001', name: 'Jogeshwari JVLR Junction', code: 'JG-01', latitude: 19.14, longitude: 72.85,
  zone: 'Western Suburbs', direction: 'Northbound', status: 'online', video_url: 'x', created_at: 't', ...over,
});

const SUMMARY = { simulated: true, stats: { vehicles: 2577, journeys: 1, sightings: 1, hop_speed_kmph: { mean: 22.3 }, sightings_per_hour: new Array(24).fill(321) } };

let location = '';
function LocationSpy() {
  const l = useLocation();
  useEffect(() => {
    location = l.pathname + l.search;
  }, [l]);
  return null;
}
const renderAt = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/" element={<><LiveMapPage /><LocationSpy /></>} />
        <Route path="*" element={<LocationSpy />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  clearCamerasCache();
  clearSimSummaryCache();
  h.flyTo.mockReset();
  h.getCameras.mockResolvedValue([cam({}), cam({ id: 'cam-002', code: 'AN-01', name: 'Andheri Flyover', status: 'offline', latitude: 19.12 })]);
  h.fetchAlerts.mockResolvedValue([
    { id: 'a1', plate_text: 'MH03IJ7890', camera_id: 'cam-001', camera_name: 'Jogeshwari JVLR Junction', priority: 'critical', timestamp: '2026-09-30T10:00:00Z', lat: 19.14, lng: 72.85, acknowledged: false },
    { id: 'a2', plate_text: 'MH43BM3816', camera_id: 'cam-002', camera_name: 'Andheri Flyover', priority: 'high', timestamp: '2026-09-30T11:00:00Z', lat: 19.12, lng: 72.85, acknowledged: false },
    { id: 'a3', plate_text: 'GJ01JK6763', camera_id: 'cam-002', camera_name: 'Andheri Flyover', priority: 'low', timestamp: '2026-09-30T11:00:00Z', lat: 19.12, lng: 72.85, acknowledged: true },
  ]);
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(SUMMARY)))));
});
afterEach(() => vi.unstubAllGlobals());

describe('LiveMapPage', () => {
  it('shows network KPIs from cameras, alerts and the simulation summary', async () => {
    renderAt('/');
    expect(await screen.findByText('1/2')).toBeInTheDocument();
    expect(await screen.findByText('321')).toBeInTheDocument();
    expect(screen.getByText('22.3')).toBeInTheDocument();
    expect(screen.getByText('2,577')).toBeInTheDocument();
    expect(await screen.findByText('1 critical')).toBeInTheDocument();
    expect(screen.getAllByTestId('marker')).toHaveLength(2);
    expect(screen.getAllByTestId('hotspot')).toHaveLength(2);
    expect(screen.getByText('Mumbai · Central Command Sector')).toBeInTheDocument();
  });

  it('keeps the page up when the summary fails', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('no', { status: 500 }))));
    renderAt('/');
    expect(await screen.findByText('1/2')).toBeInTheDocument();
    expect((await screen.findAllByText('Summary unavailable')).length).toBe(3);
  });

  it('lists open alerts by severity and selects a camera from the rail', async () => {
    renderAt('/');
    await screen.findByText('1/2');
    await userEvent.click(screen.getByRole('tab', { name: /alerts/i }));
    const list = await screen.findByRole('list', { name: 'Open alerts' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent(/critical/i);
    expect(screen.getByRole('link', { name: /view all alerts/i })).toHaveAttribute('href', '/alerts');

    await userEvent.click(screen.getByRole('tab', { name: /cameras/i }));
    await userEvent.click(screen.getByRole('button', { name: /AN-01/ }));
    expect(location).toBe('/?cam=AN-01');
    await waitFor(() => expect(h.flyTo).toHaveBeenCalled());
  });

  it('flies to a deep-linked camera and hides layers on toggle', async () => {
    renderAt('/?cam=JG-01');
    await screen.findByText('1/2');
    await waitFor(() => expect(h.flyTo).toHaveBeenCalledWith([19.14, 72.85], 15, expect.anything()));
    await userEvent.click(screen.getByRole('button', { name: 'Cameras' }));
    expect(screen.queryAllByTestId('marker')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Alert hotspots' }));
    expect(screen.queryAllByTestId('hotspot')).toHaveLength(0);
  });

  it('popup links open the feed', async () => {
    renderAt('/');
    await screen.findByText('1/2');
    await userEvent.click(screen.getAllByRole('button', { name: /open feed/i })[0]);
    expect(location).toBe('/cameras?cam=JG-01');
  });
});
