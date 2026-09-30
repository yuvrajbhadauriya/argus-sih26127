// ═══════════════════════════════════════════════════
// Operator session — Supabase Auth (email + password) or Demo mode.
//
// Live (VITE_SUPABASE_URL set): Supabase Auth; the role comes from the JWT's
//   app_metadata.role (set server-side only, see docs/DATABASE.md). The SDK is
//   loaded lazily on first use.
// Demo (no Supabase): a clearly labelled demo operator/admin identity kept in
//   localStorage, so acknowledge / admin flows work against the fixtures.
//
// Browsing is open without a session (prototype); writes need operator/admin.
// ═══════════════════════════════════════════════════

import { useEffect, useSyncExternalStore } from 'react';
import { getSupabase, isSupabaseConfigured } from '@/lib/supabase/client';

export type Role = 'admin' | 'operator' | 'analyst' | 'viewer';
export type AuthMode = 'supabase' | 'demo';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  /** Demo identity (no real authentication). */
  demo: boolean;
}

export interface AuthState {
  mode: AuthMode;
  /** 'loading' until the stored session has been checked. */
  status: 'loading' | 'ready';
  user: AuthUser | null;
}

export const WRITE_ROLES: Role[] = ['admin', 'operator'];
export const canWrite = (u: AuthUser | null | undefined): boolean => !!u && WRITE_ROLES.includes(u.role);

export const ROLE_LABEL: Record<Role, string> = { admin: 'Admin', operator: 'Operator', analyst: 'Analyst', viewer: 'Viewer' };

const DEMO_KEY = 'nero.demo-session';

export const DEMO_USERS: Record<'operator' | 'admin', AuthUser> = {
  operator: { id: 'demo-operator', email: 'operator@nero.demo', name: 'Demo Operator', role: 'operator', demo: true },
  admin: { id: 'demo-admin', email: 'admin@nero.demo', name: 'Demo Admin', role: 'admin', demo: true },
};

const mode: AuthMode = isSupabaseConfigured() ? 'supabase' : 'demo';

function readDemo(): AuthUser | null {
  try {
    const v = localStorage.getItem(DEMO_KEY);
    return v === 'operator' || v === 'admin' ? DEMO_USERS[v] : null;
  } catch {
    return null;
  }
}

let state: AuthState = mode === 'demo' ? { mode, status: 'ready', user: readDemo() } : { mode, status: 'loading', user: null };
const listeners = new Set<() => void>();

function set(next: Partial<AuthState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

const ROLES: Role[] = ['admin', 'operator', 'analyst', 'viewer'];

/** Map a Supabase user to an AuthUser (role from app_metadata; users without one are viewers). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toAuthUser(u: any): AuthUser | null {
  if (!u) return null;
  const raw = String(u.app_metadata?.role ?? '').toLowerCase() as Role;
  const email = u.email ?? '';
  const name = u.user_metadata?.full_name || u.user_metadata?.name || (email ? email.split('@')[0] : 'Operator');
  return { id: u.id, email, name, role: ROLES.includes(raw) ? raw : 'viewer', demo: false };
}

let initStarted = false;

/** Read the stored Supabase session and follow auth changes (idempotent). */
export function initAuth(): void {
  if (initStarted || mode !== 'supabase') return;
  initStarted = true;
  getSupabase()
    .then(async (sb) => {
      const { data } = await sb.auth.getSession();
      set({ status: 'ready', user: toAuthUser(data.session?.user) });
      sb.auth.onAuthStateChange((_event, session) => set({ status: 'ready', user: toAuthUser(session?.user) }));
    })
    .catch(() => set({ status: 'ready', user: null }));
}

/** Email + password sign-in (live mode). Resolves with the user or rejects with a readable message. */
export async function signInWithPassword(email: string, password: string): Promise<AuthUser> {
  if (mode !== 'supabase') throw new Error('Supabase is not configured — use a demo identity.');
  const sb = await getSupabase();
  const { data, error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw new Error(error.message === 'Invalid login credentials' ? 'Wrong email or password.' : error.message);
  const user = toAuthUser(data.user);
  set({ status: 'ready', user });
  return user!;
}

/** Demo mode: sign in as the demo operator or admin. */
export function signInDemo(role: 'operator' | 'admin' = 'operator'): AuthUser {
  try {
    localStorage.setItem(DEMO_KEY, role);
  } catch {
    /* session-only */
  }
  const user = DEMO_USERS[role];
  set({ status: 'ready', user });
  return user;
}

export async function signOut(): Promise<void> {
  if (mode === 'supabase') {
    const sb = await getSupabase();
    await sb.auth.signOut();
  } else {
    try {
      localStorage.removeItem(DEMO_KEY);
    } catch {
      /* ignore */
    }
  }
  set({ user: null, status: 'ready' });
}

export function getAuthState(): AuthState {
  return state;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
const snap = () => state;

export interface UseAuth extends AuthState {
  canWrite: boolean;
}

export function useAuth(): UseAuth {
  useEffect(() => initAuth(), []);
  const s = useSyncExternalStore(subscribe, snap, snap);
  return { ...s, canWrite: canWrite(s.user) };
}

/** Test hook. */
export function resetAuth(user: AuthUser | null = null): void {
  state = { mode, status: 'ready', user };
  listeners.forEach((l) => l());
}
