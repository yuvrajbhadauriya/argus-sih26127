// ═══════════════════════════════════════════════════
// UserMenu — signed-in operator (name + role), theme, shortcuts, sign in/out
// ═══════════════════════════════════════════════════

import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChevronDownIcon, KeyboardIcon, LogInIcon, LogOutIcon, UserRoundIcon } from 'lucide-react';
import { Popover } from '@/shared/ui/Popover';
import { Modal } from '@/shared/ui/Modal';
import { Button } from '@/shared/ui/Button';
import { Kbd } from '@/shared/ui/Input';
import { Badge } from '@/shared/ui/Badge';
import { toast } from '@/shared/ui/toast';
import { ROLE_LABEL, signOut, useAuth } from '@/features/auth/session';
import { ThemeToggle } from './ThemeToggle';

const SHORTCUTS: { keys: string[]; action: string }[] = [
  { keys: ['Ctrl', 'K'], action: 'Focus plate search' },
  { keys: ['/'], action: 'Focus plate search' },
  { keys: ['Esc'], action: 'Clear search / close dialog' },
  { keys: ['['], action: 'Previous stop (route replay)' },
  { keys: [']'], action: 'Next stop (route replay)' },
  { keys: ['Space'], action: 'Play / pause replay (map focused)' },
];

const ITEM = 'flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-[13px] text-fg hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'OP';
}

export function UserMenu() {
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const { user, mode } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const loginHref = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
  const name = user?.name ?? 'Guest';
  const sub = user ? `${ROLE_LABEL[user.role]}${user.demo ? ' · Demo' : ''}` : 'Read-only';

  return (
    <>
      <Popover
        role="dialog"
        triggerLabel={`User menu: ${user ? `${name}, ${ROLE_LABEL[user.role]}` : 'not signed in'}`}
        triggerClassName="flex h-9 items-center gap-2 rounded-sm px-1.5 text-left transition-colors hover:bg-surface-2"
        trigger={
          <>
            <span
              aria-hidden
              className={
                user
                  ? 'flex h-7 w-7 items-center justify-center rounded-full bg-primary/12 text-2xs font-semibold text-primary'
                  : 'flex h-7 w-7 items-center justify-center rounded-full bg-surface-3 text-fg-subtle'
              }
            >
              {user ? initials(name) : <UserRoundIcon size={14} strokeWidth={1.75} />}
            </span>
            <span className="hidden leading-tight xl:block">
              <span className="block text-xs font-medium text-fg">{name}</span>
              <span className="block text-2xs text-fg-subtle">{sub}</span>
            </span>
            <ChevronDownIcon size={14} className="text-fg-subtle" aria-hidden />
          </>
        }
        panelClassName="w-72 p-1"
      >
        {(close) => (
          <>
            <div className="px-2 py-2">
              {user ? (
                <>
                  <div className="text-[13px] font-medium text-fg">{user.name}</div>
                  <div className="truncate text-xs text-fg-muted">{user.email}</div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <Badge tone={user.role === 'admin' ? 'primary' : user.role === 'operator' ? 'info' : 'neutral'}>{ROLE_LABEL[user.role]}</Badge>
                    {user.demo && <Badge tone="warning">Demo identity</Badge>}
                  </div>
                </>
              ) : (
                <>
                  <div className="text-[13px] font-medium text-fg">Not signed in</div>
                  <div className="text-xs text-fg-muted">
                    Browsing is read-only. Sign in as an operator to acknowledge alerts and edit the watchlist.
                    {mode === 'demo' && ' (Demo mode)'}
                  </div>
                </>
              )}
            </div>
            <div className="my-1 h-px bg-line" />
            <div className="px-2 py-1.5">
              <div className="mb-1.5 text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">Theme</div>
              <ThemeToggle variant="segmented" className="flex w-full [&>button]:flex-1 [&>button]:justify-center" />
            </div>
            <div className="my-1 h-px bg-line" />
            <button
              type="button"
              className={ITEM}
              onClick={() => {
                close();
                setShortcutsOpen(true);
              }}
            >
              <KeyboardIcon size={16} strokeWidth={1.75} className="text-fg-subtle" aria-hidden />
              Keyboard shortcuts
            </button>
            {user ? (
              <button
                type="button"
                className={ITEM}
                onClick={async () => {
                  close();
                  try {
                    await signOut();
                    toast({ tone: 'info', title: 'Signed out', description: 'Browsing continues read-only.' });
                  } catch (err) {
                    toast({ tone: 'danger', title: 'Sign-out failed', description: err instanceof Error ? err.message : 'Please try again.' });
                  }
                }}
              >
                <LogOutIcon size={16} strokeWidth={1.75} className="text-fg-subtle" aria-hidden />
                Sign out
              </button>
            ) : (
              <button
                type="button"
                className={ITEM}
                onClick={() => {
                  close();
                  navigate(loginHref);
                }}
              >
                <LogInIcon size={16} strokeWidth={1.75} className="text-fg-subtle" aria-hidden />
                Sign in
              </button>
            )}
          </>
        )}
      </Popover>
      <Modal
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
        title="Keyboard shortcuts"
        size="sm"
        footer={
          <Button variant="primary" onClick={() => setShortcutsOpen(false)}>
            Done
          </Button>
        }
      >
        <ul className="divide-y divide-line">
          {SHORTCUTS.map((s) => (
            <li key={s.action + s.keys.join()} className="flex items-center justify-between gap-3 py-2 text-[13px]">
              <span className="text-fg-muted">{s.action}</span>
              <span className="flex gap-1">
                {s.keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </Modal>
    </>
  );
}
