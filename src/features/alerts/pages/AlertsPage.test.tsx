// AlertsPage tests with the data layer mocked (no network).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { AlertRecord } from '@/types';

const api = vi.hoisted(() => ({
  fetchAlerts: vi.fn(),
  acknowledgeAlert: vi.fn(),
}));

vi.mock('@/features/alerts/api', () => ({
  fetchAlerts: api.fetchAlerts,
  acknowledgeAlert: api.acknowledgeAlert,
}));

import { AlertsPage } from './AlertsPage';

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

beforeEach(() => {
  api.fetchAlerts.mockReset();
  api.acknowledgeAlert.mockReset();
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
