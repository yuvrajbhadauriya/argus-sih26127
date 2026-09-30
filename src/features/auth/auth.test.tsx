import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, renderHook } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { DEMO_USERS, canWrite, getAuthState, resetAuth, signInDemo, signOut, toAuthUser, useAuth } from './session';
import { closeSignInPrompt, getSignInPrompt, safeNext, useOperatorAction } from './guard';
import { LoginPage } from './LoginPage';
import { clearToasts, getToasts } from '@/shared/ui/toast';

beforeEach(() => {
  resetAuth(null);
  closeSignInPrompt();
  clearToasts();
  localStorage.clear();
});

describe('session (demo mode — no Supabase in tests)', () => {
  it('starts signed out in demo mode', () => {
    expect(getAuthState()).toMatchObject({ mode: 'demo', status: 'ready', user: null });
  });

  it('signs in / out a clearly labelled demo identity and persists it', async () => {
    const u = signInDemo('operator');
    expect(u).toMatchObject({ role: 'operator', demo: true, name: 'Demo Operator' });
    expect(localStorage.getItem('nero.demo-session')).toBe('operator');
    const { result } = renderHook(() => useAuth());
    expect(result.current.canWrite).toBe(true);
    await act(() => signOut());
    expect(result.current.user).toBeNull();
    expect(localStorage.getItem('nero.demo-session')).toBeNull();
  });

  it('maps Supabase users: role from app_metadata only, unknown → viewer', () => {
    expect(toAuthUser({ id: '1', email: 'a@b.in', app_metadata: { role: 'operator' }, user_metadata: { role: 'admin' } })).toMatchObject({
      role: 'operator', name: 'a', demo: false,
    });
    expect(toAuthUser({ id: '2', email: 'x@y.in', app_metadata: {} })!.role).toBe('viewer');
    expect(toAuthUser({ id: '3', email: 'x@y.in', app_metadata: { role: 'root' } })!.role).toBe('viewer');
    expect(toAuthUser(null)).toBeNull();
  });

  it('only operator and admin may write', () => {
    expect(canWrite(DEMO_USERS.operator)).toBe(true);
    expect(canWrite(DEMO_USERS.admin)).toBe(true);
    expect(canWrite({ ...DEMO_USERS.operator, role: 'analyst' })).toBe(false);
    expect(canWrite(null)).toBe(false);
  });
});

describe('useOperatorAction guard', () => {
  it('runs the action for operators', () => {
    resetAuth(DEMO_USERS.operator);
    const { result } = renderHook(() => useOperatorAction());
    const fn = vi.fn();
    result.current('acknowledge alerts', fn);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('prompts guests to sign in instead of running or erroring', () => {
    const { result } = renderHook(() => useOperatorAction());
    const fn = vi.fn();
    act(() => result.current('acknowledge alerts', fn));
    expect(fn).not.toHaveBeenCalled();
    expect(getSignInPrompt()).toEqual({ reason: 'acknowledge alerts' });
    expect(getToasts()).toHaveLength(0);
  });

  it('explains the role requirement to signed-in viewers', () => {
    resetAuth({ ...DEMO_USERS.operator, role: 'viewer' });
    const { result } = renderHook(() => useOperatorAction());
    const fn = vi.fn();
    act(() => result.current('edit the watchlist', fn));
    expect(fn).not.toHaveBeenCalled();
    expect(getToasts().at(-1)).toMatchObject({ tone: 'warning', title: 'Operator role required' });
  });

  it('safeNext only allows same-origin paths', () => {
    expect(safeNext('/alerts?id=1')).toBe('/alerts?id=1');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('/login')).toBe('/');
    expect(safeNext(null)).toBe('/');
  });
});

describe('LoginPage (demo mode)', () => {
  function Where() {
    const l = useLocation();
    return <p data-testid="where">{l.pathname + l.search}</p>;
  }
  const renderLogin = (path = '/login?next=%2Falerts') =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );

  it('labels demo mode and signs in as the demo operator, returning to ?next', async () => {
    renderLogin();
    expect(screen.getByRole('heading', { name: /operator sign-in/i })).toBeInTheDocument();
    expect(screen.getByText(/demo mode\./i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /continue as demo operator/i }));
    expect(screen.getByTestId('where')).toHaveTextContent('/alerts');
    expect(getAuthState().user).toMatchObject({ role: 'operator', demo: true });
    expect(getToasts().at(-1)).toMatchObject({ tone: 'success', title: 'Signed in as Demo Operator' });
  });

  it('shows the current session with sign-out when already signed in', async () => {
    resetAuth(DEMO_USERS.admin);
    renderLogin('/login');
    expect(screen.getByText(/signed in as/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /sign out/i }));
    expect(getAuthState().user).toBeNull();
  });
});
