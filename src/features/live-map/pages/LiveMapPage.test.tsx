// LiveMapPage: KPIs from the sim summary + alerts, rail tabs, ?cam= selection.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { useEffect, type ReactNode } from 'react';
import type { Camera } from '@/types/camera';

const h = vi.hoisted(() => ({ flyTo: vi.fn(), fitBounds: vi.fn(), getCameras: vi.fn(), fetchAlerts: vi.fn(), fetchAllCameraEvents: vi.fn() }));

vi.mock('react-leaflet', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div data-testid="leaflet">{children}</div>;
  return {
    MapContainer: Pass, TileLayer: () => null, Marker: ({ children, title }: { children?: ReactNode; title?: string }) => <div data-testid="marker" title={title}>{children}</div>,
    Popup: Pass, Tooltip: Pass, CircleMarker: () => <div data-testid="hotspot" />,
    useMap: () => ({ fitBounds: h.fitBounds, setView: vi.fn(), flyTo: h.flyTo, getZoom: () => 12 }),
  };
});
vi.mock('@/features/cameras/api', () => ({ getCameras: h.getCameras }));
vi.mock('@/features/alerts/api', () => ({
  fetchAlerts: h.fetchAlerts,
  fetchBlacklistEntries: () => Promise.resolve([{ plate_text: 'MH 02 GB 4920', priority: 'critical', is_active: true }]),
}));
vi.mock('@/features/detections/api', async (orig) => ({
  ...(await orig<typeof import('@/features/detections/api')>()),
  fetchAllCameraEvents: h.fetchAllCameraEvents,
}));

import { LiveMapPage } from './LiveMapPage';
import { clearCamerasCache } from '@/features/cameras/hooks/useCameras';
import { clearSimSummaryCache } from '../api';
import { resetReadCrops } from '@/features/detections/lib/readCrops';

const cam = (over: Partial<Camera>): Camera => ({
  id: 'cam-001', name: 'Jogeshwari JVLR Junction', code: 'JG-01', latitude: 19.14, longitude: 72.85,
  zone: 'Western Suburbs', direction: 'Northbound', status: 'online', video_url: 'x', created_at: 't', ...over,
});

const SUMMARY = { simulated: true, stats: { vehicles: 2577, journeys: 1, sightings: 1, hop_speed_kmph: { mean: 22.3 }, sightings_per_hour: new Array(24).fill(321) } };

// Fixture figures, deliberately not the real ones: the tile must show whatever the file says.
const GOLDEN = { set: 'ocr_golden_v1', measured_at: '2026-09-30T22:17:01+05:30', overall: { n: 200, correct: 150, accuracy: 0.75 }, items: [{ key: 'a', gt: 'MH02AB1234', pred: 'MH02AB1234', correct: true, confidence: 99 }, { key: 'b', gt: 'MH03CD5678', pred: 'MH03CD5679', correct: false, confidence: 80 }] };
const CROPS = { crops: { 'JG-01_trk_3_3000': { vehicle: 'JG-01/JG-01_trk_3_3000_vehicle.jpg', plate: 'JG-01/JG-01_trk_3_3000_plate.jpg' } } };

function stubFetch(over: Record<string, () => Response> = {}) {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    const hit = Object.entries(over).find(([k]) => String(url).includes(k));
    if (hit) return Promise.resolve(hit[1]());
    if (String(url).includes('/golden/')) return Promise.resolve(new Response(JSON.stringify(GOLDEN)));
    if (String(url).includes('/detections/crops/')) return Promise.resolve(new Response(JSON.stringify(CROPS)));
    return Promise.resolve(new Response(JSON.stringify(SUMMARY)));
  }));
}

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
  resetReadCrops();
  stubFetch();
  const ev = (t: number, plate: string | null, conf: number) => ({
    camera_code: 'JG-01', tracked_vehicle_id: `trk_${t}`, plate_text: plate, plate_read: null, plate_confidence: conf, grammar_valid: !!plate,
    vehicle_type: 'car', vehicle_class: 'Car', time_sec: t, bbox: { x: 0, y: 0, width: 10, height: 10 },
  });
  h.fetchAllCameraEvents.mockResolvedValue([
    { camera_code: 'JG-01', duration_sec: 30, events: [ev(3, 'MH 02 GB 4920', 0.98), ev(9, 'MH 01 AB 1234', 0.7), ev(15, null, 0.2)] },
  ]);
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

  it('streams real model reads (good reads only) in the live feed, flagging watchlist plates', async () => {
    renderAt('/');
    await screen.findByText('1/2');
    const list = await screen.findByRole('list', { name: 'Latest plate reads' });
    expect(within(list).getAllByText('MH 02 GB 4920').length).toBeGreaterThan(0);
    expect(within(list).queryByText('MH 01 AB 1234')).toBeNull(); // below 75 %
    expect(screen.getByText('Real ANPR reads')).toBeInTheDocument();
    await waitFor(() => expect(within(list).getAllByText('Critical').length).toBeGreaterThan(0));
  });

  it('shows real vehicle + plate crops on rows that have them, the plain row otherwise', async () => {
    renderAt('/');
    await screen.findByText('1/2');
    const list = await screen.findByRole('list', { name: 'Latest plate reads' });
    await waitFor(() => expect(within(list).getAllByRole('img', { name: /Plate crop for MH 02 GB 4920/ }).length).toBeGreaterThan(0));
    expect(within(list).getAllByRole('img', { name: /Vehicle MH 02 GB 4920/ })[0]).toHaveAttribute('src', '/detections/crops/JG-01/JG-01_trk_3_3000_vehicle.jpg');
    expect(within(list).getAllByText('MH 02 GB 4920').length).toBeGreaterThan(0); // OCR text kept
    expect(screen.getByText('Real ANPR reads')).toBeInTheDocument();
  });

  it('lists only reads that have a plate crop: without a manifest there are no camera rows at all', async () => {
    stubFetch({ '/detections/crops/manifest.json': () => new Response('', { status: 404 }) });
    renderAt('/');
    await screen.findByText('1/2');
    const list = await screen.findByRole('list', { name: 'Latest plate reads' });
    await waitFor(() => expect(within(list).queryAllByLabelText(/^Golden set plate:/).length).toBeGreaterThan(0));
    expect(within(list).queryByText('MH 02 GB 4920')).toBeNull();
    expect(within(list).queryAllByRole('img', { name: /^(Plate crop for|Vehicle )/ })).toHaveLength(0);
    expect(within(list).queryByText('no crop')).toBeNull();
  });

  it('leaves the vehicle slot out when the read has no vehicle crop, and when its image fails', async () => {
    stubFetch({ '/detections/crops/manifest.json': () => new Response(JSON.stringify({ crops: { 'JG-01_trk_3_3000': { vehicle: null, plate: 'JG-01/p.jpg' } } })) });
    renderAt('/');
    const list = await screen.findByRole('list', { name: 'Latest plate reads' });
    await within(list).findAllByRole('img', { name: /Plate crop for MH 02 GB 4920/ });
    expect(within(list).queryAllByRole('img', { name: /^Vehicle / })).toHaveLength(0);
    expect(within(list).queryByText('no crop')).toBeNull();
  });

  it('hides a crop whose file fails to load (no broken image, no placeholder)', async () => {
    renderAt('/');
    const list = await screen.findByRole('list', { name: 'Latest plate reads' });
    const veh = (await within(list).findAllByRole('img', { name: /^Vehicle MH 02 GB 4920/ }))[0];
    fireEvent.error(veh);
    await waitFor(() => expect(veh.isConnected).toBe(false));
    expect(within(list).queryByText('no crop')).toBeNull();
  });

  it('shows the golden-set plate OCR accuracy read from the results file, linking to /accuracy', async () => {
    renderAt('/');
    expect(await screen.findByText('75.00%')).toBeInTheDocument();
    expect(screen.getByText('Model accuracy')).toBeInTheDocument();
    expect(screen.getByText(/Plate OCR accuracy · golden set · readable plates · n = 200/)).toBeInTheDocument();
    expect(screen.getByText(/Measured 30 Sept 2026 · exact match/)).toBeInTheDocument();
    expect(screen.queryByText(/end-to-end/i)).toBeNull();
    expect(screen.getByTitle(/150 of 200 readable plate crops read exactly right/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Model accuracy/ }));
    expect(location).toBe('/accuracy');
  });

  it('shows a dash instead of a figure when the golden results are not published', async () => {
    stubFetch({ '/golden/': () => new Response('', { status: 404 }) });
    renderAt('/');
    expect(await screen.findByText('Golden-set results unavailable')).toBeInTheDocument();
    expect(screen.queryByText('75.00%')).toBeNull();
  });

  it('mixes clearly separate golden-set rows into the feed and filters All / Cameras / Golden set', async () => {
    renderAt('/');
    await screen.findByText('1/2');
    const list = await screen.findByRole('list', { name: 'Latest plate reads' });
    const goldenRows = () => within(list).queryAllByLabelText(/^Golden set plate:/);
    await waitFor(() => expect(goldenRows().length).toBeGreaterThan(0));
    const row = goldenRows()[0];
    expect(within(row).getByText('Golden set')).toBeInTheDocument();
    expect(within(row).getByText('Read')).toBeInTheDocument();
    expect(within(row).getByText('Truth')).toBeInTheDocument();
    expect(within(row).getByRole('img', { name: /^(Correct|Wrong)$/ })).toBeInTheDocument();
    expect(row.textContent).not.toMatch(/JG-01|Jogeshwari|ago|live/i);   // no camera, no live wording
    expect(within(list).getAllByText('MH 02 GB 4920').length).toBeGreaterThan(0); // camera reads still there

    await userEvent.click(screen.getByRole('button', { name: 'Feed: Cameras' }));
    expect(goldenRows()).toHaveLength(0);
    expect(within(list).getAllByText('MH 02 GB 4920').length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole('button', { name: 'Feed: Golden set' }));
    await waitFor(() => expect(goldenRows().length).toBeGreaterThan(0));
    expect(within(list).queryByText('MH 02 GB 4920')).toBeNull();
    expect(screen.queryByText('Real ANPR reads')).toBeNull();
  });

  it('marks a wrong golden-set read, highlighting the ground truth next to it', async () => {
    renderAt('/');
    await screen.findByText('1/2');
    await userEvent.click(await screen.findByRole('button', { name: 'Feed: Golden set' }));
    const list = await screen.findByRole('list', { name: 'Latest plate reads' });
    await waitFor(() => expect(within(list).queryAllByLabelText(/ground truth MH03CD5678, wrong/).length).toBeGreaterThan(0));
    const row = within(list).getAllByLabelText(/ground truth MH03CD5678, wrong/)[0];
    expect(within(row).getByRole('img', { name: 'Model read MH03CD5679' })).toBeInTheDocument();
    expect(within(row).getByRole('img', { name: 'Wrong' })).toBeInTheDocument();
  });

  it('popup links open the feed', async () => {
    renderAt('/');
    await screen.findByText('1/2');
    await userEvent.click(screen.getAllByRole('button', { name: /open feed/i })[0]);
    expect(location).toBe('/cameras?cam=JG-01');
  });
});
