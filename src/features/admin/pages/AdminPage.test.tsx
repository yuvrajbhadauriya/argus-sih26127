import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { mockCameras } from '@/mocks/fixtures/mockCameras';
import { mockBlacklistEntries } from '@/mocks/fixtures/mockAlerts';
import type { Camera } from '@/types/camera';

const api = vi.hoisted(() => ({ fetchCameras: vi.fn(), fetchBlacklistEntries: vi.fn() }));
vi.mock('@/features/cameras/api', async (orig) => ({ ...(await orig<object>()), fetchCameras: api.fetchCameras }));
vi.mock('@/features/alerts/api', async (orig) => ({ ...(await orig<object>()), fetchBlacklistEntries: api.fetchBlacklistEntries }));

import { AdminPage } from './AdminPage';
import { clearToasts, getToasts } from '@/shared/ui/toast';
import { DEMO_USERS, resetAuth } from '@/features/auth/session';
import { SignInPrompt } from '@/features/auth/SignInPrompt';
import { closeSignInPrompt } from '@/features/auth/guard';

const CAMS: Camera[] = mockCameras.slice(0, 3).map((c) => ({
  id: c.id, name: c.name, code: c.code, latitude: c.lat, longitude: c.lng, zone: c.zone, direction: c.direction, road: c.road,
  status: 'online', video_url: '', created_at: '2026-09-01T00:00:00Z',
}));

beforeEach(() => {
  clearToasts();
  resetAuth(DEMO_USERS.admin);
  closeSignInPrompt();
  api.fetchCameras.mockReset().mockResolvedValue(CAMS);
  api.fetchBlacklistEntries.mockReset().mockResolvedValue(mockBlacklistEntries.map((e) => ({ ...e })));
});

const renderPage = () => render(<MemoryRouter><AdminPage /><SignInPrompt /></MemoryRouter>);

describe('AdminPage', () => {
  it('lists cameras and validates the register-camera form', async () => {
    renderPage();
    expect(await screen.findByText(CAMS[0].name)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /register camera/i }));
    const dialog = screen.getByRole('dialog', { name: /register camera/i });
    await userEvent.type(within(dialog).getByLabelText(/code/i), CAMS[0].code);
    await userEvent.click(within(dialog).getByRole('button', { name: /register camera/i }));
    expect(within(dialog).getByText(/enter a camera name/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/already registered/i)).toBeInTheDocument();

    await userEvent.type(within(dialog).getByLabelText(/camera name/i), 'ITO Crossing');
    const code = within(dialog).getByLabelText(/code/i);
    await userEvent.clear(code);
    await userEvent.type(code, 'it-01');
    await userEvent.click(within(dialog).getByRole('button', { name: /register camera/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('ITO Crossing')).toBeInTheDocument();
    expect(getToasts().at(-1)).toMatchObject({ tone: 'success', title: 'Camera registered' });
  });

  it('adds a watchlist plate with a formatted preview and toggles entries', async () => {
    renderPage();
    await screen.findByText(CAMS[0].name);
    await userEvent.click(screen.getByRole('tab', { name: /watchlist/i }));
    await userEvent.click(screen.getByRole('button', { name: /add plate/i }));
    const dialog = screen.getByRole('dialog', { name: /add plate/i });
    await userEvent.type(within(dialog).getByLabelText(/plate number/i), 'mh12ab1234');
    expect(within(dialog).getByLabelText('Plate MH 12 AB 1234')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: /add to watchlist/i }));
    expect(within(dialog).getByText(/short reason/i)).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText(/reason/i), 'Hit and run, FIR 88/2026');
    await userEvent.click(within(dialog).getByRole('button', { name: /add to watchlist/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('link', { name: 'Plate MH 12 AB 1234' })).toBeInTheDocument();

    const sw = screen.getAllByRole('switch')[0];
    const before = sw.getAttribute('aria-checked');
    await userEvent.click(sw);
    expect(sw.getAttribute('aria-checked')).not.toBe(before);
  });

  it('prompts to sign in (not an error) when a guest tries to write', async () => {
    resetAuth(null);
    renderPage();
    await screen.findByText(CAMS[0].name);
    expect(screen.getByText(/read-only · sign in to edit/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /register camera/i }));
    const prompt = screen.getByRole('dialog', { name: /sign in required/i });
    expect(within(prompt).getByText(/register cameras/i)).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /register camera$/i })).toBeNull();
    expect(getToasts().filter((t) => t.tone === 'danger')).toHaveLength(0);
  });

  it('edits a camera through the same form (code locked)', async () => {
    renderPage();
    await screen.findByText(CAMS[0].name);
    await userEvent.click(screen.getByRole('button', { name: `Edit ${CAMS[0].code}` }));
    const dialog = screen.getByRole('dialog', { name: new RegExp(`edit camera ${CAMS[0].code}`, 'i') });
    expect(within(dialog).getByLabelText(/code/i)).toBeDisabled();
    const name = within(dialog).getByLabelText(/camera name/i);
    await userEvent.clear(name);
    await userEvent.type(name, 'Renamed Junction');
    await userEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('Renamed Junction')).toBeInTheDocument();
  });

  it('shows the error state with retry', async () => {
    api.fetchCameras.mockRejectedValueOnce(new Error('registry offline'));
    renderPage();
    expect(await screen.findByText('registry offline')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText(CAMS[0].name)).toBeInTheDocument();
  });

  it('system tab lists the model, data source and a theme control', async () => {
    renderPage();
    await screen.findByText(CAMS[0].name);
    await userEvent.click(screen.getByRole('tab', { name: /system/i }));
    expect(screen.getByText(/AI ANPR engine \(trained Indian-plate model\)/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/DEIM|PARSeq|deim50k|raw35|YOLO/i);
    expect(screen.getByText(/Simulated network/)).toBeInTheDocument();
    expect(screen.getByText(/Demo Admin/)).toBeInTheDocument();
    expect(screen.getByRole('radiogroup')).toBeInTheDocument();
  });
});
