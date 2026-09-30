// ═══════════════════════════════════════════════════
// SignInPrompt — "Sign in required" dialog opened by requestSignIn()
// (see ./guard.ts). Mounted once in the dashboard layout.
// ═══════════════════════════════════════════════════

import { useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { LogInIcon } from 'lucide-react';
import { Modal } from '@/shared/ui/Modal';
import { Button } from '@/shared/ui/Button';
import { Badge } from '@/shared/ui/Badge';
import { getAuthState } from './session';
import { closeSignInPrompt as closePrompt, getSignInPrompt, subscribeSignInPrompt } from './guard';

/** Mounted once in the layout. */
export function SignInPrompt() {
  const current = useSyncExternalStore(subscribeSignInPrompt, getSignInPrompt, getSignInPrompt);
  const navigate = useNavigate();
  const location = useLocation();
  const demo = getAuthState().mode === 'demo';
  const next = `${location.pathname}${location.search}`;

  return (
    <Modal
      open={current != null}
      onClose={closePrompt}
      title="Sign in required"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={closePrompt}>Keep browsing</Button>
          <Button
            variant="primary"
            icon={<LogInIcon size={14} />}
            data-autofocus
            onClick={() => {
              closePrompt();
              navigate(`/login?next=${encodeURIComponent(next)}`);
            }}
          >
            Sign in
          </Button>
        </>
      }
    >
      <p className="text-[13px] text-fg">
        Sign in as an operator to {current?.reason ?? 'make changes'}. Browsing stays open without an account.
      </p>
      {demo && (
        <p className="mt-3 flex items-center gap-2 text-xs text-fg-muted">
          <Badge tone="warning">Demo mode</Badge> No database is configured — a demo operator identity is available.
        </p>
      )}
    </Modal>
  );
}
