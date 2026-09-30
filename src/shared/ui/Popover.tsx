// ═══════════════════════════════════════════════════
// Popover — anchored floating panel (click to toggle, Esc / outside click close)
// ═══════════════════════════════════════════════════

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/shared/lib/cn';

export function Popover({
  trigger,
  triggerLabel,
  triggerClassName,
  children,
  align = 'end',
  className,
  panelClassName,
  role = 'dialog',
}: {
  /** Content of the trigger button. */
  trigger: ReactNode;
  /** Accessible name of the trigger button (when its content is not enough). */
  triggerLabel?: string;
  triggerClassName?: string;
  /** Panel content; a function receives `close`. */
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: 'start' | 'end';
  className?: string;
  panelClassName?: string;
  role?: 'dialog' | 'menu';
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        ref={btnRef}
        type="button"
        aria-haspopup={role}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={triggerLabel}
        onClick={() => setOpen((o) => !o)}
        className={triggerClassName}
      >
        {trigger}
      </button>
      {open && (
        <div
          id={id}
          role={role}
          className={cn(
            'absolute top-full z-[1500] mt-1.5 min-w-[220px] rounded-md border border-line bg-surface text-fg shadow-pop animate-fade-in',
            align === 'end' ? 'right-0' : 'left-0',
            panelClassName,
          )}
        >
          {typeof children === 'function' ? children(close) : children}
        </div>
      )}
    </div>
  );
}
