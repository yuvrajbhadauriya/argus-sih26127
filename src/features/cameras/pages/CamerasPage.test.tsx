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
import { useCameras, clearCamerasCache, prefetchCameras } from '@/features/cameras/hooks/useCameras';

const cam = (over: Partial<Camera>): Camera => ({
  id: 'cam-001', name: 'India Gate Junction', code: 'IG-01', latitude: 28.6, longitude: 77.2,
  zone: 'Central Delhi', direction: 'N', status: 'online', video_url: 'https://x/a.mp4', created_at: 't', ...over,
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
