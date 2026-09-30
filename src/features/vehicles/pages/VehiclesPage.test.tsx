import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactNode } from 'react';

vi.mock('react-leaflet', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div data-testid="leaflet">{children}</div>;
  return {
    MapContainer: Pass, TileLayer: () => null, Marker: Pass, Popup: Pass, Tooltip: Pass,
    Polyline: () => <div data-testid="polyline" />, CircleMarker: Pass, ZoomControl: () => null,
    useMap: () => ({ fitBounds: vi.fn(), setView: vi.fn(), flyTo: vi.fn(), invalidateSize: vi.fn(), addLayer: vi.fn(), removeLayer: vi.fn() }),
  };
});

import { VehiclesPage } from './VehiclesPage';
import { resetSimCache } from '../sim';

const SUMMARY = JSON.parse(readFileSync(resolve(process.cwd(), 'public/sim/summary.json'), 'utf8'));
const [W1, W2] = SUMMARY.demo.watchlist.map((w: { plate_text: string }) => w.plate_text) as string[];

function setReducedMotion(reduced: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: reduced && q.includes('reduce'), media: q, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
}

beforeEach(() => {
  resetSimCache();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const file = resolve(process.cwd(), 'public', String(url).replace(/^\//, ''));
    if (!existsSync(file)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(file, 'utf8')) };
  }));
  setReducedMotion(false);
});

afterEach(() => vi.unstubAllGlobals());

/** Stand-in for the top-bar global search: navigates while the page stays mounted. */
function GlobalSearchStub() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(`/vehicles?plate=${encodeURIComponent(W2.replace(/ /g, ''))}`)}>global-search</button>;
}

const renderPage = (path = '/vehicles') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <GlobalSearchStub />
      <VehiclesPage />
    </MemoryRouter>,
  );

const targetPlate = () => document.getElementById('vehicle-target')?.querySelector('[aria-label^="Plate "]')?.getAttribute('aria-label') ?? '';

describe('VehiclesPage', () => {
  it('opens on the first watchlist plate with a road-snapped journey and synced timeline', async () => {
    renderPage();
    const timeline = await screen.findByRole('list', { name: /chronological camera sightings/i });
    // watchlist chip comes first and is selected
    const chips = screen.getAllByRole('button', { name: /^(DL|HR|UP|MH|KA|PB|TN|RJ|WB|GJ) \d\d/ });
    expect(chips[0]).toHaveTextContent(W1);
    expect(screen.getAllByText(W1).length).toBeGreaterThan(1);
    expect(screen.getAllByText(/Simulated city network/).length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('polyline').length).toBeGreaterThan(4);
    expect(screen.getByText('Road distance')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /replay journey/i })).toBeInTheDocument();

    const items = within(timeline).getAllByRole('button');
    expect(items.length).toBeGreaterThanOrEqual(8);
    fireEvent.click(items[2]);
    expect(items[2]).toHaveAttribute('aria-current', 'step');
  });

  it('finds a plate typed without spaces in lower case', async () => {
    renderPage();
    await screen.findByRole('list', { name: /chronological camera sightings/i });
    const input = screen.getByRole('textbox', { name: /licence plate/i });
    fireEvent.change(input, { target: { value: W2.toLowerCase().replace(/ /g, '') } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(targetPlate()).toContain(W2));
  });

  it('follows ?plate= changes while the page is open (global search)', async () => {
    renderPage();
    await waitFor(() => expect(targetPlate()).toContain(W1));
    fireEvent.click(screen.getByRole('button', { name: 'global-search' }));
    await waitFor(() => expect(targetPlate()).toContain(W2));
    expect(screen.getByRole('textbox', { name: /licence plate/i })).toHaveValue(W2);
  });

  it('shows a not-found state for an unknown plate', async () => {
    renderPage('/vehicles?plate=ZZ99ZZ9999');
    expect(await screen.findByText(/No sightings for ZZ 99 ZZ 9999/)).toBeInTheDocument();
  });

  it('shows the anomaly banner for the cloned plate from the URL', async () => {
    const clone = SUMMARY.demo.anomalies.find((a: { kind: string }) => a.kind === 'cloned_plate').plate_text;
    renderPage(`/vehicles?plate=${encodeURIComponent(clone)}`);
    expect(await screen.findByText(/possible cloned plate/i)).toBeInTheDocument();
  });

  it('uses step controls instead of animation when reduced motion is preferred', async () => {
    setReducedMotion(true);
    renderPage();
    await screen.findByRole('list', { name: /chronological camera sightings/i });
    expect(screen.queryByRole('button', { name: /replay journey/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /next stop/i }));
    const timeline = screen.getByRole('list', { name: /chronological camera sightings/i });
    expect(within(timeline).getAllByRole('button')[0]).toHaveAttribute('aria-current', 'step');
  });

  it('renders an empty state when the simulation files are unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    resetSimCache();
    renderPage();
    expect(await screen.findByText(/search a vehicle plate/i)).toBeInTheDocument();
  });
});
