import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { DashboardLayout } from './DashboardLayout';

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
});
