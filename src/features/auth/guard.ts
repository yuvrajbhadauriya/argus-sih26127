// ═══════════════════════════════════════════════════
// Role guard for write actions.
//
// useOperatorAction() wraps a write (acknowledge, register camera, edit
// watchlist…): signed in as operator/admin → runs it; not signed in → opens the
// "Sign in to …" prompt (./SignInPrompt.tsx — never an error); signed in
// without a write role → explains the role requirement.
// ═══════════════════════════════════════════════════

import { useCallback } from 'react';
import { toast } from '@/shared/ui/toast';
import { ROLE_LABEL, getAuthState, canWrite } from './session';

let prompt: { reason: string } | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Ask the user to sign in before doing `reason` (e.g. "acknowledge alerts"). */
export function requestSignIn(reason: string): void {
  prompt = { reason };
  emit();
}

export function closeSignInPrompt(): void {
  prompt = null;
  emit();
}

export function subscribeSignInPrompt(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export const getSignInPrompt = () => prompt;

/** Returns guard(reason, action): runs `action` only for operator/admin sessions. */
export function useOperatorAction() {
  return useCallback((reason: string, action: () => void) => {
    const { user } = getAuthState();
    if (canWrite(user)) return action();
    if (!user) return requestSignIn(reason);
    toast({
      tone: 'warning',
      title: 'Operator role required',
      description: `Your account (${ROLE_LABEL[user.role]}) can view but not ${reason}. Ask an admin to grant the operator role.`,
    });
  }, []);
}

/** Only same-origin paths are allowed as /login?next= targets. */
export function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/login')) return '/';
  return raw;
}
