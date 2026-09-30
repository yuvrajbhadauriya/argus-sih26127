// Page-level smoke tests with the data layer mocked (no network).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, renderHook, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { AlertRecord } from '@/types';
import type { Camera } from '@/types/camera';

const api = vi.hoisted(() => ({
  fetchAlerts: vi.fn(),
  acknowledgeAlert: vi.fn(),
  getCameras: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  fetchAlerts: api.fetchAlerts,
  acknowledgeAlert: api.acknowledgeAlert,
}));
vi.mock('@/lib/supabase/cameras', () => ({ getCameras: api.getCameras }));
// The video player pulls in canvas/video APIs jsdom lacks; not under test here.
vi.mock('@/components/video/CameraVideoPlayer', () => ({ CameraVideoPlayer: () => <div data-testid="player" /> }));

import { AlertsPage } from './AlertsPage';
import { CamerasPage } from './CamerasPage';
import { useCameras } from '@/hooks/useCameras';

const alert = (over: Partial<AlertRecord>): AlertRecord => ({
  id: 'a',
  detection_event_id: 'd',
  blacklist_entry_id: 'b',
  plate_text: 'DL-01-AB-1234',
  camera_id: 'cam-001',
  camera_name: 'India Gate',
  priority: 'high',
  category: 'stolen',
  reason: 'r',
  timestamp: '2026-09-25T07:30:00Z',
  lat: 28.6,
  lng: 77.2,
  acknowledged: false,
  ...over,
});

const cam = (over: Partial<Camera>): Camera => ({
  id: 'cam-001', name: 'India Gate Junction', code: 'IG-01', latitude: 28.6, longitude: 77.2,
  zone: 'Central Delhi', direction: 'N', status: 'online', video_url: 'https://x/a.mp4', created_at: 't', ...over,
});

beforeEach(() => {
  api.fetchAlerts.mockReset();
  api.acknowledgeAlert.mockReset();
  api.getCameras.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('AlertsPage', () => {
  const renderPage = () => render(<MemoryRouter><AlertsPage /></MemoryRouter>);

  it('shows pending alerts and hides acknowledged ones by default', async () => {
    api.fetchAlerts.mockResolvedValue([
      alert({ id: '1', plate_text: 'PENDING-1' }),
      alert({ id: '2', plate_text: 'DONE-2', acknowledged: true }),
    ]);
    renderPage();
    expect(await screen.findByText('PENDING-1')).toBeInTheDocument();
    expect(screen.queryByText('DONE-2')).toBeNull();
    expect(screen.getByText(/1 Pending Action/)).toBeInTheDocument();
  });

  it('renders the empty state when no alerts', async () => {
    api.fetchAlerts.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('No Watchlist Alerts Found')).toBeInTheDocument();
  });

  it('renders the error state and retries', async () => {
    api.fetchAlerts.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce([]);
    renderPage();
    expect(await screen.findByText('db down')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('No Watchlist Alerts Found')).toBeInTheDocument();
    expect(api.fetchAlerts).toHaveBeenCalledTimes(2);
  });

  it('filters by priority', async () => {
    api.fetchAlerts.mockResolvedValue([
      alert({ id: '1', plate_text: 'CRIT-1', priority: 'critical' }),
      alert({ id: '2', plate_text: 'LOW-2', priority: 'low' }),
    ]);
    renderPage();
    await screen.findByText('CRIT-1');
    await userEvent.selectOptions(screen.getAllByRole('combobox')[0], 'low');
    expect(screen.queryByText('CRIT-1')).toBeNull();
    expect(screen.getByText('LOW-2')).toBeInTheDocument();
  });

  it('acknowledging removes the alert from the pending list', async () => {
    api.fetchAlerts.mockResolvedValue([alert({ id: '1', plate_text: 'ACK-ME' })]);
    api.acknowledgeAlert.mockResolvedValue(undefined);
    renderPage();
    await screen.findByText('ACK-ME');
    const btn = screen.getAllByRole('button').find((b) => /acknowledge/i.test(b.textContent ?? ''));
    expect(btn).toBeDefined();
    await userEvent.click(btn!);
    await waitFor(() => expect(screen.queryByText('ACK-ME')).toBeNull());
    expect(api.acknowledgeAlert).toHaveBeenCalledWith('1', 'Admin Operator');
  });
});

describe('useCameras', () => {
  it('loads cameras and exposes refetch', async () => {
    api.getCameras.mockResolvedValue([cam({})]);
    const { result } = renderHook(() => useCameras());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.cameras).toHaveLength(1);
    api.getCameras.mockRejectedValue(new Error('x'));
    await act(async () => { await result.current.refetch(); });
    expect(result.current.error).toBe('x');
  });
});

describe('CamerasPage', () => {
  it('renders camera cards and filters by zone', async () => {
    api.getCameras.mockResolvedValue([
      cam({ id: 'c1', name: 'Alpha Cam', zone: 'Z1' }),
      cam({ id: 'c2', name: 'Beta Cam', code: 'CP-01', zone: 'Z2', status: 'offline' }),
    ]);
    render(<MemoryRouter><CamerasPage /></MemoryRouter>);
    expect(await screen.findByText('Alpha Cam')).toBeInTheDocument();
    expect(screen.getByText('Beta Cam')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole('combobox'), 'Z2');
    expect(screen.queryByText('Alpha Cam')).toBeNull();
  });

  // BUG (UI): the header badge reads "{cameras.length} Active Feeds" and counts
  // offline cameras as active (CamerasPage.tsx:48).
  it.fails('BUG: "Active Feeds" count excludes offline cameras', async () => {
    api.getCameras.mockResolvedValue([cam({ id: 'c1' }), cam({ id: 'c2', code: 'X', status: 'offline' })]);
    render(<MemoryRouter><CamerasPage /></MemoryRouter>);
    expect(await screen.findByText('1 Active Feeds')).toBeInTheDocument();
  });

  it('shows the empty message when there are no cameras', async () => {
    api.getCameras.mockResolvedValue([]);
    render(<MemoryRouter><CamerasPage /></MemoryRouter>);
    expect(await screen.findByText('No cameras found')).toBeInTheDocument();
  });
});
