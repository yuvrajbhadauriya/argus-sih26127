// LoginPage + session against a (fake) configured Supabase Auth.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

const h = vi.hoisted(() => ({
  signIn: vi.fn(),
  signOut: vi.fn(async () => ({ error: null })),
  session: null as unknown,
  onChange: null as null | ((e: string, s: unknown) => void),
}));

vi.mock('@/lib/supabase/client', () => ({
  isSupabaseConfigured: () => true,
  getSupabase: async () => ({
    auth: {
      getSession: async () => ({ data: { session: h.session } }),
      onAuthStateChange: (cb: (e: string, s: unknown) => void) => {
        h.onChange = cb;
        return { data: { subscription: { unsubscribe() {} } } };
      },
      signInWithPassword: h.signIn,
      signOut: h.signOut,
    },
  }),
}));

import { LoginPage } from './LoginPage';
import { getAuthState, initAuth, signOut } from './session';

function Where() {
  const l = useLocation();
  return <p data-testid="where">{l.pathname}</p>;
}
const renderLogin = () =>
  render(
    <MemoryRouter initialEntries={['/login?next=%2Fadmin']}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  h.signIn.mockReset();
});

describe('LoginPage — Supabase Auth', () => {
  it('reads the stored session on start (role from app_metadata)', async () => {
    h.session = { user: { id: 'u1', email: 'op@city.gov.in', app_metadata: { role: 'operator' } } };
    initAuth();
    await waitFor(() => expect(getAuthState()).toMatchObject({ mode: 'supabase', status: 'ready', user: { role: 'operator', demo: false } }));
    await signOut();
    expect(h.signOut).toHaveBeenCalled();
    expect(getAuthState().user).toBeNull();
  });

  it('shows a readable error for wrong credentials, then signs in and returns to ?next', async () => {
    renderLogin();
    await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter your email and password.');

    h.signIn.mockResolvedValueOnce({ data: { user: null }, error: { message: 'Invalid login credentials' } });
    await userEvent.type(screen.getByLabelText(/email/i), 'op@city.gov.in');
    await userEvent.type(screen.getByLabelText(/password/i), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    expect(await screen.findByText('Wrong email or password.')).toBeInTheDocument();

    h.signIn.mockResolvedValueOnce({ data: { user: { id: 'u2', email: 'op@city.gov.in', app_metadata: { role: 'admin' } } }, error: null });
    await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/admin'));
    expect(h.signIn).toHaveBeenLastCalledWith({ email: 'op@city.gov.in', password: 'wrong' });
    expect(getAuthState().user).toMatchObject({ role: 'admin', email: 'op@city.gov.in' });
  });
});
