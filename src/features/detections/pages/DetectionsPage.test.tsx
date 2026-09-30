// DetectionsPage: URL-synced filters, watchlist tone, drawer, CSV export.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { DetectionsPage } from './DetectionsPage';
import { clearCamerasCache } from '@/features/cameras/hooks/useCameras';

let location = '';
function LocationSpy() {
  const l = useLocation();
  useEffect(() => {
    location = l.pathname + l.search;
  }, [l]);
  return null;
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/detections" element={<><DetectionsPage /><LocationSpy /></>} />
        <Route path="*" element={<LocationSpy />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  clearCamerasCache();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('DetectionsPage', () => {
  it('renders the header, KPIs and rows', async () => {
    renderAt('/detections');
    expect(screen.getByRole('heading', { name: 'Detections' })).toBeInTheDocument();
    expect(await screen.findAllByLabelText(/^Plate DL 01 AB 1234/)).not.toHaveLength(0);
    expect(screen.getByText('Unique plates')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /export csv/i })).toBeEnabled();
  });

  it('reads filters from the URL (camera deep link from the Live Map)', async () => {
    renderAt('/detections?camera=cam-002');
    await screen.findByText(/of \d+ events/);
    const table = screen.getByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.length).toBeGreaterThan(0);
    expect(screen.getByRole('combobox', { name: 'Camera' })).toHaveValue('cam-002');
    expect(screen.getByRole('button', { name: /clear filters/i })).toBeInTheDocument();
  });

  it('writes the plate filter to the URL (debounced) and clears filters', async () => {
    renderAt('/detections');
    await screen.findByText(/of \d+ events/);
    await userEvent.type(screen.getByRole('textbox', { name: /filter by plate/i }), 'zz99');
    await waitFor(() => expect(location).toContain('plate=ZZ99'));
    expect(await screen.findByText('No detections match these filters')).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: /clear filters/i })[0]);
    await waitFor(() => expect(location).toBe('/detections'));
  });

  it('opens a detail drawer on row click and traces the route', async () => {
    renderAt('/detections?plate=HR26CD5678');
    const table = await screen.findByRole('table');
    const row = await waitFor(() => {
      const r = within(table).getAllByRole('row').slice(1)[0];
      expect(r).toBeTruthy();
      return r;
    });
    await userEvent.click(row);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Raw OCR text')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: /trace route/i }));
    expect(location).toBe('/vehicles?plate=HR26CD5678');
  });
});
