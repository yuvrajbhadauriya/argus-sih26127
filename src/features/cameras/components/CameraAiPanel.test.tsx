// CameraAiPanel: live GPU reads (real crops + OCR) when the model answers, recorded reads otherwise.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Camera } from '@/types/camera';
import type { LiveAnprState } from '@/features/detections/hooks/useLiveAnpr';

const mocks = vi.hoisted(() => ({
  live: vi.fn(),
}));

vi.mock('@/features/detections/hooks/useLiveAnpr', () => ({ useLiveAnpr: mocks.live }));
// Recorded reads / watchlist / engine status are other units' business.
vi.mock('@/features/detections/hooks/useLiveReads', () => ({
  useLiveReads: () => ({ reads: [], docs: [], loading: false, now: Date.now() }),
  useNowSeconds: () => Date.now(),
}));
vi.mock('@/features/detections/hooks/useWatchlistKeys', () => ({
  useWatchlistIndex: () => new Map([['MH01AA1111', 'high']]),
}));
vi.mock('@/features/ai-engine/components/AiEngineStatus', () => ({ AiEngineStatusPill: () => <div data-testid="engine" /> }));

import { CameraAiPanel } from './CameraAiPanel';

const camera = { id: 'c1', code: 'JG-01', name: 'Jogeshwari JVLR Junction', zone: 'Western Suburbs', road: 'WEH' } as Camera;

const row = (over: Record<string, unknown> = {}) => ({
  id: 'JG-01-1-0', camera_code: 'JG-01', plate: 'MH 02 DJ 8770', key: 'MH02DJ8770', confidence: 0.94,
  plateCrop: { dataUrl: 'data:image/jpeg;base64,PLATE', width: 82, height: 31 },
  vehicleCrop: { dataUrl: 'data:image/jpeg;base64,VEH', width: 200, height: 160 },
  at: Date.UTC(2026, 9, 3, 6, 30), lastSeenAt: Date.UTC(2026, 9, 3, 6, 30), frameTimeSec: 3.2, sightings: 3, ...over,
});

const state = (over: Partial<LiveAnprState>): LiveAnprState => ({
  status: 'live', reads: [], frames: 0, latencyMs: null, modelVersion: null, reason: null, ...over,
});

const renderPanel = (video: HTMLVideoElement | null = document.createElement('video')) =>
  render(
    <MemoryRouter>
      <CameraAiPanel camera={camera} feedStatus="playing" detections={[]} resolution="1280×720" lastFrameAt={null} video={video} />
    </MemoryRouter>,
  );

beforeEach(() => mocks.live.mockReset());

describe('CameraAiPanel live ANPR', () => {
  it('runs the live loop on the playing feed only', () => {
    mocks.live.mockReturnValue(state({ status: 'off' }));
    const video = document.createElement('video');
    renderPanel(video);
    expect(mocks.live).toHaveBeenCalledWith(video, 'JG-01');
    mocks.live.mockClear();
    render(
      <MemoryRouter>
        <CameraAiPanel camera={camera} feedStatus="connecting" detections={[]} resolution={null} lastFrameAt={null} video={video} />
      </MemoryRouter>,
    );
    expect(mocks.live).toHaveBeenCalledWith(null, 'JG-01');
  });

  it('shows each live read with its real plate crop, vehicle crop, OCR text and confidence', () => {
    mocks.live.mockReturnValue(state({ reads: [row() as never], frames: 12, latencyMs: 840, modelVersion: 'deim50k+raw35' }));
    renderPanel();
    expect(screen.getByText(/GPU live · 12 frames · 840 ms/)).toBeInTheDocument();
    expect(screen.getByAltText('Plate crop for MH 02 DJ 8770')).toHaveAttribute('src', 'data:image/jpeg;base64,PLATE');
    expect(screen.getByAltText('Vehicle MH 02 DJ 8770')).toHaveAttribute('src', 'data:image/jpeg;base64,VEH');
    expect(screen.getByRole('img', { name: /Plate MH 02 DJ 8770/ })).toBeInTheDocument();
    expect(screen.getByText('94%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Trace MH 02 DJ 8770' })).toBeInTheDocument();
    expect(screen.queryByText(/Frames of this feed are sent/)).toBeNull();
  });

  it('shows a placeholder instead of a crop when the model gave no box, and flags watchlist plates', () => {
    mocks.live.mockReturnValue(state({ reads: [row({ plate: 'MH 01 AA 1111', key: 'MH01AA1111', plateCrop: null, vehicleCrop: null }) as never], frames: 1 }));
    renderPanel();
    expect(screen.queryByAltText(/Plate crop/)).toBeNull();
    expect(screen.getAllByText('no crop')).toHaveLength(2);
    expect(screen.getByRole('img', { name: /Plate MH 01 AA 1111, watchlist/ })).toBeInTheDocument();
  });

  it('says it is analysing while the model has not read a plate yet', () => {
    mocks.live.mockReturnValue(state({ reads: [], frames: 2, latencyMs: 700 }));
    renderPanel();
    expect(screen.getByText('Analysing live frames…')).toBeInTheDocument();
    expect(screen.queryByText(/Frames of this feed are sent/)).toBeNull();
  });

  it('falls back to the recorded reads, labelled as replayed, without an error line when the GPU model is unreachable', () => {
    mocks.live.mockReturnValue(state({ status: 'unavailable', reason: 'LAN/VPN-only' }));
    renderPanel();
    expect(screen.queryByText(/not reachable/)).toBeNull();
    expect(screen.getByText(/Real reads by the AI ANPR engine on this clip/)).toBeInTheDocument();
    expect(screen.queryByText(/GPU live/)).toBeNull();
  });

  it('shows the recorded reads while connecting', () => {
    mocks.live.mockReturnValue(state({ status: 'connecting' }));
    renderPanel();
    expect(screen.getByText('Connecting to the live GPU model…')).toBeInTheDocument();
  });
});
