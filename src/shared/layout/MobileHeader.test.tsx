import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { MobileHeader } from './MobileHeader';

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{loc.pathname + loc.search}</p>;
}

function renderHeader() {
  return render(
    <MemoryRouter>
      <MobileHeader />
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('MobileHeader', () => {
  it('compact row: logo, search, status, bell, theme and user menu - no inline search field or Ctrl+K hint', async () => {
    renderHeader();
    expect(screen.getByText('NERO')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search vehicle plate' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /System status/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Alerts/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Switch to (dark|light) theme/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /User menu/ })).toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.queryByText('Ctrl')).not.toBeInTheDocument();
  });

  it('the search button opens a full-width search that navigates to Vehicle Trace', async () => {
    const user = userEvent.setup();
    renderHeader();
    await user.click(screen.getByRole('button', { name: 'Search vehicle plate' }));
    const input = screen.getByRole('searchbox', { name: 'Search vehicle plate' });
    expect(input).toHaveFocus();
    await user.type(input, 'mh 01 cs 0126{Enter}');
    expect(screen.getByTestId('where')).toHaveTextContent('/vehicles?plate=MH01CS0126');
    // overlay closes and the header row is back
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search vehicle plate' })).toBeInTheDocument();
  });

  it('Cancel and Esc close the search without navigating', async () => {
    const user = userEvent.setup();
    renderHeader();
    await user.click(screen.getByRole('button', { name: 'Search vehicle plate' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Search vehicle plate' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/');
  });
});
