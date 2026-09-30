// ═══════════════════════════════════════════════════
// UserMenu — operator identity, theme, shortcuts (demo build: no auth)
// ═══════════════════════════════════════════════════

import { useState } from 'react';
import { ChevronDownIcon, KeyboardIcon, LogOutIcon } from 'lucide-react';
import { Popover } from '@/shared/ui/Popover';
import { Modal } from '@/shared/ui/Modal';
import { Button } from '@/shared/ui/Button';
import { Kbd } from '@/shared/ui/Input';
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

export function UserMenu() {
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  return (
    <>
      <Popover
        role="dialog"
        triggerLabel="User menu: Duty Officer"
        triggerClassName="flex h-9 items-center gap-2 rounded-sm px-1.5 text-left transition-colors hover:bg-surface-2"
        trigger={
          <>
            <span aria-hidden className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/12 text-2xs font-semibold text-primary">
              DO
            </span>
            <span className="hidden leading-tight xl:block">
              <span className="block text-xs font-medium text-fg">Duty Officer</span>
              <span className="block text-2xs text-fg-subtle">Control Room</span>
            </span>
            <ChevronDownIcon size={14} className="text-fg-subtle" aria-hidden />
          </>
        }
        panelClassName="w-64 p-1"
      >
        {(close) => (
          <>
            <div className="px-2 py-2">
              <div className="text-[13px] font-medium text-fg">Duty Officer</div>
              <div className="text-xs text-fg-muted">Control Room · Operator</div>
            </div>
            <div className="my-1 h-px bg-line" />
            <div className="flex items-center justify-between gap-2 px-2 py-1.5">
              <span className="text-xs text-fg-muted">Theme</span>
              <ThemeToggle variant="segmented" />
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
            <button type="button" className={ITEM} disabled title="Demo build">
              <LogOutIcon size={16} strokeWidth={1.75} className="text-fg-subtle" aria-hidden />
              Sign out
            </button>
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
