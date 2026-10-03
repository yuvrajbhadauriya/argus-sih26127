import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { BottomNav } from './BottomNav';

function renderNav(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <BottomNav />
      <Routes>
        <Route path="*" element={<p>page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('BottomNav', () => {
  it('shows the four primary tabs with visible labels plus More', () => {
    renderNav();
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    for (const label of ['Live Map', 'Cameras', 'Alerts', 'Detections']) {
      expect(within(nav).getByRole('link', { name: new RegExp(label) })).toBeVisible();
    }
    expect(within(nav).getByRole('button', { name: 'More' })).toHaveAttribute('aria-haspopup', 'dialog');
  });

  it('marks the current page with aria-current', () => {
    renderNav('/cameras');
    expect(screen.getByRole('link', { name: /Cameras/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /Live Map/ })).not.toHaveAttribute('aria-current');
  });

  it('More opens a sheet with the remaining pages, and navigating closes it', async () => {
    const user = userEvent.setup();
    renderNav();
    await user.click(screen.getByRole('button', { name: 'More' }));
    const sheet = screen.getByRole('dialog', { name: 'More' });
    const more = within(sheet).getByRole('navigation', { name: 'More pages' });
    expect(within(more).getAllByRole('link').map((l) => l.textContent)).toEqual([
      'Vehicle Trace',
      'Accuracy Proof',
      'Analytics',
      'Model Performance',
      'Admin',
    ]);
    await user.click(within(more).getByRole('link', { name: 'Analytics' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('More is highlighted when the current page lives in the sheet; Esc closes the sheet', async () => {
    const user = userEvent.setup();
    renderNav('/admin');
    const more = screen.getByRole('button', { name: 'More' });
    expect(more).toHaveAttribute('data-active', 'true');
    await user.click(more);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
