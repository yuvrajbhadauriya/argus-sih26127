import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { act } from '@testing-library/react';
import { DashboardLayout } from './DashboardLayout';
import { DEMO_USERS, resetAuth } from '@/features/auth/session';
import { resetReplay, startReplay, istOnDay, formatReplayClock } from '@/features/replay/clock';
import { emitAlertEvent } from '@/features/alerts/live';
import { clearToasts, getToasts } from '@/shared/ui/toast';
import { mockAlertFeed } from '@/mocks/fixtures/mockAlerts';

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{loc.pathname + loc.search}</p>;
}

function renderShell(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<DashboardLayout />}>
          <Route path="*" element={<Where />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('DashboardLayout shell', () => {
  it('renders grouped nav links, a skip link and main landmark', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderShell();
    for (const name of ['Live Map', 'Cameras', 'Alerts', 'Vehicle Trace', 'Detections', 'Analytics', 'Admin']) {
      expect(screen.getByRole('link', { name: new RegExp(name) })).toBeInTheDocument();
    }
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#main');
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
  });

  it('global plate search navigates to Vehicle Trace with the normalised plate', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderShell('/cameras');
    const input = screen.getByRole('searchbox', { name: 'Search vehicle plate' });
    await userEvent.type(input, 'mh 01-cs 0126{Enter}');
    expect(screen.getByTestId('where')).toHaveTextContent('/vehicles?plate=MH01CS0126');
  });

  it('Ctrl+K focuses the search and Esc clears it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderShell();
    const input = screen.getByRole('searchbox', { name: 'Search vehicle plate' });
    await userEvent.keyboard('{Control>}k{/Control}');
    expect(document.activeElement).toBe(input);
    await userEvent.type(input, 'ab');
    await userEvent.keyboard('{Escape}');
    expect(input).toHaveValue('');
    expect(document.activeElement).not.toBe(input);
  });

  it('shows the live unacknowledged alert count on the Alerts nav item', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fetchAlerts } = await import('@/features/alerts/api');
    const open = (await fetchAlerts()).filter((a) => !a.acknowledged).length;
    renderShell();
    if (open > 0) {
      await waitFor(() => expect(screen.getByTitle(`${open} unacknowledged alerts`)).toBeInTheDocument());
    }
  });

  it('shows an IST clock in the top bar', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderShell();
    expect(screen.getAllByText('IST').length).toBeGreaterThan(0);
  });

  it('user menu: guest can sign in; a signed-in user shows name, role and can sign out', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    resetAuth(null);
    renderShell('/alerts');
    await userEvent.click(screen.getByRole('button', { name: /user menu: not signed in/i }));
    await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    expect(screen.getByTestId('where')).toHaveTextContent('/login?next=%2Falerts');
    act(() => resetAuth(DEMO_USERS.admin));
    await userEvent.click(screen.getByRole('button', { name: /user menu: demo admin, admin/i }));
    expect(screen.getByText('Demo identity')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /sign out/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /user menu: not signed in/i })).toBeInTheDocument());
  });

  it('shows the single data-source indicator in the top bar status', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderShell();
    expect(await screen.findByRole('button', { name: /data source: simulated network/i })).toBeInTheDocument();
  });

  it('a live alert event raises a toast with an "Open alert" action', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    clearToasts();
    renderShell();
    // The bridge is lazy: wait until it is subscribed (status pill rendered ≈ shell settled).
    await screen.findByRole('button', { name: /data source/i });
    const a = mockAlertFeed[0];
    await waitFor(() => {
      act(() => emitAlertEvent({ type: 'insert', source: 'replay', alert: a }));
      expect(getToasts().some((t) => t.title.includes(a.plate_text))).toBe(true);
    });
    await userEvent.click(screen.getAllByRole('button', { name: 'Open alert' })[0]);
    expect(screen.getByTestId('where')).toHaveTextContent(`/alerts?id=${encodeURIComponent(a.id)}`);
  });

  it('replay mode narrows the nav badge to alerts fired so far', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = Math.min(...mockAlertFeed.map((x) => Date.parse(x.timestamp)));
    renderShell();
    act(() => startReplay(formatReplayClock(first - 60_000)));
    expect(istOnDay(formatReplayClock(first - 60_000))).toBeLessThan(first);
    await waitFor(() => expect(screen.queryByTitle(/unacknowledged alerts/)).toBeNull());
    act(() => resetReplay());
  });
});
