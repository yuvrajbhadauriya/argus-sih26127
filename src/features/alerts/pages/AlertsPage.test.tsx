// AlertsPage tests with the data layer mocked (no network).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { AlertRecord } from '@/types';
import type { TriageAlert } from '../types';

const api = vi.hoisted(() => ({
  fetchAlerts: vi.fn(),
  acknowledgeAlert: vi.fn(),
  fetchBlacklistEntries: vi.fn(),
  fetchTrajectoryByPlate: vi.fn(),
}));

vi.mock('@/features/alerts/api', () => ({
  fetchAlerts: api.fetchAlerts,
  acknowledgeAlert: api.acknowledgeAlert,
  fetchBlacklistEntries: api.fetchBlacklistEntries,
}));
vi.mock('@/features/vehicles/api', () => ({ fetchTrajectoryByPlate: api.fetchTrajectoryByPlate }));
vi.mock('react-leaflet', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div data-testid="leaflet">{children}</div>;
  return { MapContainer: Pass, TileLayer: () => null, CircleMarker: Pass, Polyline: () => null, Tooltip: Pass, useMap: () => ({}) };
});

import { AlertsPage } from './AlertsPage';
import { clearToasts, getToasts } from '@/shared/ui/toast';

const alert = (over: Partial<AlertRecord>): AlertRecord => ({
  id: 'a',
  detection_event_id: 'd',
  blacklist_entry_id: 'b',
  plate_text: 'MH-01-AB-1234',
  camera_id: 'cam-001',
  camera_name: 'Jogeshwari',
  priority: 'high',
  category: 'stolen',
  reason: 'r',
  timestamp: '2026-09-25T07:30:00Z',
  lat: 19.14,
  lng: 72.85,
  acknowledged: false,
  ...over,
});

beforeEach(() => {
  api.fetchAlerts.mockReset();
  api.acknowledgeAlert.mockReset();
  api.fetchBlacklistEntries.mockReset().mockResolvedValue([]);
  api.fetchTrajectoryByPlate.mockReset().mockResolvedValue(null);
  clearToasts();
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
    expect((await screen.findAllByText('PENDING-1')).length).toBeGreaterThan(0);
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
    await screen.findAllByText('CRIT-1');
    await userEvent.selectOptions(screen.getAllByRole('combobox')[0], 'low');
    expect(screen.queryByText('CRIT-1')).toBeNull();
    expect(screen.getAllByText('LOW-2').length).toBeGreaterThan(0);
  });

  it('acknowledging removes the alert from the pending list', async () => {
    api.fetchAlerts.mockResolvedValue([alert({ id: '1', plate_text: 'ACK-ME' })]);
    api.acknowledgeAlert.mockResolvedValue(undefined);
    renderPage();
    await screen.findAllByText('ACK-ME');
    const btn = screen.getAllByRole('button').find((b) => /acknowledge/i.test(b.textContent ?? ''));
    expect(btn).toBeDefined();
    await userEvent.click(btn!);
    await waitFor(() => expect(screen.queryByText('ACK-ME')).toBeNull());
    expect(api.acknowledgeAlert).toHaveBeenCalledWith('1', 'Admin Operator');
    expect(getToasts().at(-1)).toMatchObject({ tone: 'success', title: 'Alert acknowledged' });
  });

  it('reverts and shows a danger toast when acknowledging fails', async () => {
    api.fetchAlerts.mockResolvedValue([alert({ id: '1', plate_text: 'FAIL-ME' })]);
    api.acknowledgeAlert.mockRejectedValue(new Error('network down'));
    renderPage();
    await screen.findAllByText('FAIL-ME');
    const btn = screen.getAllByRole('button').find((b) => /acknowledge/i.test(b.textContent ?? ''))!;
    await userEvent.click(btn);
    await waitFor(() => expect(getToasts().at(-1)).toMatchObject({ tone: 'danger', description: 'network down' }));
    expect(screen.getAllByText('FAIL-ME').length).toBeGreaterThan(0);
    expect(screen.getByText(/1 Pending Action/)).toBeInTheDocument();
  });

  it('lists route anomalies with evidence and filters them by type', async () => {
    const anomaly: TriageAlert = alert({ id: 'x', plate_text: 'CLONE-1', priority: 'critical', reason: 'Possible cloned plate' });
    anomaly.kind = 'cloned_plate';
    anomaly.camera_code = 'BH-01';
    anomaly.evidence = [
      { camera_code: 'AN-01', timestamp: '2026-09-29T09:03:48+05:30' },
      { camera_code: 'BH-01', timestamp: '2026-09-29T09:06:52+05:30' },
    ];
    api.fetchAlerts.mockResolvedValue([anomaly, alert({ id: 'w', plate_text: 'WATCH-1' })]);
    renderPage();
    await screen.findAllByText('CLONE-1');
    // anomaly is critical → top of the queue and selected: evidence timeline shown
    expect(screen.getByRole('list', { name: /evidence sightings/i })).toBeInTheDocument();
    expect(screen.getAllByText('Cloned plate').length).toBeGreaterThan(0);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /filter by type/i }), 'watchlist');
    expect(screen.queryByText('CLONE-1')).toBeNull();
    expect(screen.getByRole('button', { name: /view route of WATCH-1/i })).toBeInTheDocument();
  });
});
