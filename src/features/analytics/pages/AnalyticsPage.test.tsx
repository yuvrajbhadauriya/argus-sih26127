import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactNode } from 'react';

vi.mock('react-leaflet', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div data-testid="leaflet">{children}</div>;
  return { MapContainer: Pass, TileLayer: () => null, CircleMarker: Pass, Circle: () => null, Polyline: () => <div data-testid="polyline" />, Tooltip: Pass, useMap: () => ({}) };
});

import { AnalyticsPage } from './AnalyticsPage';
import { resetSimCache } from '@/features/vehicles/sim';
import { clearAnalyticsCache } from '../api';

const SUMMARY = JSON.parse(readFileSync(resolve(process.cwd(), 'public/sim/summary.json'), 'utf8'));
const fmt = (n: number) => n.toLocaleString('en-IN');

beforeEach(() => {
  resetSimCache();
  clearAnalyticsCache();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const file = resolve(process.cwd(), 'public', String(url).replace(/^\//, ''));
    if (!existsSync(file)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(file, 'utf8')) };
  }));
});
afterEach(() => vi.unstubAllGlobals());

const renderPage = (path = '/analytics') => render(<MemoryRouter initialEntries={[path]}><AnalyticsPage /></MemoryRouter>);

describe('AnalyticsPage', () => {
  it('shows full-day KPIs from the simulated network with the simulation badge', async () => {
    renderPage();
    expect(await screen.findByText(fmt(SUMMARY.stats.journeys))).toBeInTheDocument();
    expect(screen.getByText(fmt(SUMMARY.stats.vehicles))).toBeInTheDocument();
    expect(screen.getAllByText(/Simulated city network/).length).toBeGreaterThan(0);
    expect(screen.getByRole('img', { name: /sightings per hour/i })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /distribution of hop speeds/i })).toBeInTheDocument();
    expect(screen.getAllByTestId('polyline').length).toBeGreaterThan(5); // route density layer
  });

  it('the time window re-scopes the numbers', async () => {
    renderPage();
    await screen.findByText(fmt(SUMMARY.stats.journeys));
    fireEvent.change(screen.getByRole('combobox', { name: /time window/i }), { target: { value: 'am_peak' } });
    await waitFor(() => expect(screen.queryByText(fmt(SUMMARY.stats.journeys))).toBeNull());
    const tile = screen.getByText('Journeys').closest('div')!.parentElement!;
    const n = Number(within(tile).getAllByText(/^[\d,]+$/)[0].textContent!.replace(/,/g, ''));
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(SUMMARY.stats.journeys);
  });

  it('renders the OD matrix and corridor table without glyph arrows', async () => {
    renderPage('/analytics?tab=od');
    expect(await screen.findByRole('img', { name: /journeys between zones/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /corridors/i }));
    const table = await screen.findByRole('table', { name: /corridor statistics/i });
    expect(within(table).getAllByRole('row').length).toBeGreaterThan(5);
    expect(document.body.textContent).not.toMatch(/[↔→]/);
  });

  it('shows a per-panel error with retry when the journey log is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    renderPage();
    expect((await screen.findAllByRole('button', { name: /try again/i })).length).toBeGreaterThan(1);
  });
});
