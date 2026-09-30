// DetectionsPage: URL-synced filters, watchlist tone, drawer, CSV export.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { CameraEvents, PlateEvent } from '../api';

// The log is built from the published model output (events_<code>.json);
// the files are replaced by this fixture so the test never hits the network.
const ev = (id: string, plate: string | null, conf: number | null, t: number, extra: Partial<PlateEvent> = {}): PlateEvent => ({
  camera_code: '', tracked_vehicle_id: id, plate_text: plate, plate_read: plate?.replace(/\s+/g, '') ?? 'XX', plate_confidence: conf,
  grammar_valid: plate != null, vehicle_type: 'car', vehicle_class: 'Car', time_sec: t, bbox: { x: 10, y: 10, width: 40, height: 40 }, ...extra,
});
const EVENTS: CameraEvents[] = [
  { camera_code: 'JG-01', duration_sec: 30, events: [ev('trk_1', 'MH 01 CS 0126', 0.93, 3.8), ev('trk_2', null, 0.2, 5), ev('trk_3', 'MH 14 XJ 0057', 0.6, 8)] },
  { camera_code: 'AN-01', duration_sec: 46, events: [ev('trk_9', 'MH 47 EL 9660', 0.88, 4.4, { vehicle_type: 'truck' }), ev('trk_10', 'MH 03 ZQ 2351', 0.97, 8.4)] },
];
vi.mock('../api', async (orig) => ({
  ...(await orig<typeof import('../api')>()),
  fetchAllCameraEvents: () => Promise.resolve(EVENTS),
}));

import { DetectionsPage } from './DetectionsPage';
import { clearCamerasCache } from '@/features/cameras/hooks/useCameras';
import { eventsToLogRows } from '../hooks/useDetectionsLog';

const LOG_PLATE = 'MH03ZQ2351';

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

describe('eventsToLogRows', () => {
  it('keeps only verified reads (valid grammar, OCR above the display threshold) and maps them to log rows', () => {
    const rows = eventsToLogRows(EVENTS);
    expect(rows.map((r) => r.plate_text_raw)).toEqual(['MH 01 CS 0126', 'MH 47 EL 9660', 'MH 03 ZQ 2351']);
    expect(rows[1]).toMatchObject({ event_id: 'AN-01-trk_9', camera_id: 'cam-002', confidence_score: 0.88, vehicle_type: 'truck', frame_timestamp_sec: 4.4 });
  });
});

describe('DetectionsPage', () => {
  it('renders the header, KPIs and rows', async () => {
    renderAt('/detections');
    expect(screen.getByRole('heading', { name: 'Detections' })).toBeInTheDocument();
    expect(await screen.findAllByLabelText(/^Plate MH 01 CS 0126/)).not.toHaveLength(0);
    expect(screen.getByText('Unique plates')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /export csv/i })).toBeEnabled();
    // 3 verified reads of 5 detected vehicles
    expect(screen.getByText('Vehicles detected')).toBeInTheDocument();
    expect(screen.getByText('60% with a verified plate read')).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Plate MH 14 XJ 0057/)).not.toBeInTheDocument();
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
    renderAt(`/detections?plate=${LOG_PLATE}`);
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
    expect(location).toBe(`/vehicles?plate=${LOG_PLATE}`);
  });
});
