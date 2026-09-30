// CamerasPage + useCameras tests with the data layer mocked (no network).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, renderHook, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { Camera } from '@/types/camera';

const api = vi.hoisted(() => ({
  getCameras: vi.fn(),
}));

vi.mock('@/features/cameras/api', () => ({ getCameras: api.getCameras }));
// The video player pulls in canvas/video APIs jsdom lacks; not under test here.
vi.mock('@/features/cameras/components/CameraVideoPlayer', () => ({ CameraVideoPlayer: () => <div data-testid="player" /> }));

import { CamerasPage } from './CamerasPage';
import { pickCamera } from '../lib/pickCamera';
import { useCameras, clearCamerasCache, prefetchCameras } from '@/features/cameras/hooks/useCameras';

const cam = (over: Partial<Camera>): Camera => ({
  id: 'cam-001', name: 'Jogeshwari JVLR Junction', code: 'JG-01', latitude: 19.14, longitude: 72.85,
  zone: 'Western Suburbs', direction: 'N', status: 'online', video_url: 'https://x/a.mp4', created_at: 't', ...over,
});

beforeEach(() => {
  clearCamerasCache();
  api.getCameras.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
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

  it('de-duplicates concurrent loads and serves later mounts from cache', async () => {
    api.getCameras.mockResolvedValue([cam({})]);
    const a = renderHook(() => useCameras());
    const b = renderHook(() => useCameras());
    await waitFor(() => expect(a.result.current.loading).toBe(false));
    await waitFor(() => expect(b.result.current.loading).toBe(false));
    expect(api.getCameras).toHaveBeenCalledTimes(1);
    a.unmount();
    b.unmount();
    // navigating back: instant data, no spinner, no request
    const c = renderHook(() => useCameras());
    expect(c.result.current.loading).toBe(false);
    expect(c.result.current.cameras).toHaveLength(1);
    expect(api.getCameras).toHaveBeenCalledTimes(1);
  });

  it('refetch bypasses the cache; errors are not cached', async () => {
    api.getCameras.mockRejectedValueOnce(new Error('down'));
    const a = renderHook(() => useCameras());
    await waitFor(() => expect(a.result.current.error).toBe('down'));
    api.getCameras.mockResolvedValue([cam({})]);
    await act(async () => { await a.result.current.refetch(); });
    expect(a.result.current.error).toBeNull();
    expect(a.result.current.cameras).toHaveLength(1);
    expect(api.getCameras).toHaveBeenCalledTimes(2);
  });

  it('prefetchCameras warms the cache', async () => {
    api.getCameras.mockResolvedValue([cam({})]);
    prefetchCameras();
    await waitFor(() => expect(api.getCameras).toHaveBeenCalledTimes(1));
    await act(async () => {});
    const { result } = renderHook(() => useCameras());
    expect(result.current.loading).toBe(false);
    expect(result.current.cameras).toHaveLength(1);
  });
});

describe('CamerasPage', () => {
  it('renders the wall + selected feed and filters by zone (the zone Select is the only combobox)', async () => {
    api.getCameras.mockResolvedValue([
      cam({ id: 'c1', name: 'Alpha Cam', zone: 'Z1' }),
      cam({ id: 'c2', name: 'Beta Cam', code: 'AN-01', zone: 'Z2', status: 'offline' }),
    ]);
    render(<MemoryRouter><CamerasPage /></MemoryRouter>);
    expect((await screen.findAllByText('Alpha Cam')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Beta Cam').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
    await userEvent.selectOptions(screen.getByRole('combobox'), 'Z2');
    expect(screen.queryByText('Alpha Cam')).toBeNull();
  });

  // Was a BUG: the header read "{cameras.length} Active Feeds", counting offline cameras.
  it('header counts online and offline cameras separately', async () => {
    api.getCameras.mockResolvedValue([cam({ id: 'c1' }), cam({ id: 'c2', code: 'X', status: 'offline' })]);
    render(<MemoryRouter><CamerasPage /></MemoryRouter>);
    expect(await screen.findByText('Camera Network')).toBeInTheDocument();
    expect(screen.getByText('1 online')).toBeInTheDocument();
    expect(screen.getByText('1 offline')).toBeInTheDocument();
    expect(screen.queryByText(/Active Feeds/)).toBeNull();
  });

  it('selects the camera from ?cam= and defaults to the first online camera', async () => {
    const cams = [
      cam({ id: 'c1', name: 'Offline First', code: 'OF-01', status: 'offline' }),
      cam({ id: 'c2', name: 'Online Second', code: 'ON-02' }),
      cam({ id: 'c3', name: 'Third', code: 'TH-03' }),
    ];
    api.getCameras.mockResolvedValue(cams);
    const { unmount } = render(<MemoryRouter><CamerasPage /></MemoryRouter>);
    await screen.findByRole('heading', { name: /Online Second/ });
    expect(screen.getByRole('button', { name: 'Open feed ON-02 Online Second' })).toHaveAttribute('aria-pressed', 'true');
    unmount();

    render(<MemoryRouter initialEntries={['/cameras?cam=TH-03']}><CamerasPage /></MemoryRouter>);
    await screen.findByRole('heading', { name: /Third/ });
    await userEvent.click(screen.getByRole('button', { name: 'Open feed OF-01 Offline First' }));
    expect(screen.getByRole('heading', { name: /Offline First/ })).toBeInTheDocument();
  });

  it('pickCamera falls back sensibly', () => {
    expect(pickCamera([], 'X')).toBeNull();
    const a = cam({ id: 'a', code: 'A', status: 'offline' });
    const b = cam({ id: 'b', code: 'B' });
    expect(pickCamera([a, b], null)).toBe(b);
    expect(pickCamera([a, b], 'A')).toBe(a);
    expect(pickCamera([a], 'missing')).toBe(a);
  });

  it('shows the empty message when there are no cameras', async () => {
    api.getCameras.mockResolvedValue([]);
    render(<MemoryRouter><CamerasPage /></MemoryRouter>);
    expect(await screen.findByText('No cameras found')).toBeInTheDocument();
  });

  it('shows an error with retry', async () => {
    api.getCameras.mockRejectedValue(new Error('boom'));
    render(<MemoryRouter><CamerasPage /></MemoryRouter>);
    expect(await screen.findByText('boom')).toBeInTheDocument();
    api.getCameras.mockResolvedValue([cam({})]);
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect((await screen.findAllByText('Jogeshwari JVLR Junction')).length).toBeGreaterThan(0);
  });
});
