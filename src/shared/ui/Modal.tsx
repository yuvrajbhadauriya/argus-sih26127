// ═══════════════════════════════════════════════════
// Modal / Drawer — portal dialogs with focus trap, Esc/scrim close,
// focus restore and body scroll lock. z-[2000] sits above Leaflet (≤1000).
// ═══════════════════════════════════════════════════

import { useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { XIcon } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { IconButton } from './Button';
import { useDialogBehaviour } from './useDialogBehaviour';

const MODAL_WIDTH = { sm: 'max-w-[400px]', md: 'max-w-[560px]', lg: 'max-w-[800px]' } as const;

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  useDialogBehaviour(open, onClose, panelRef);
  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-[2000] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-scrim animate-fade-in" onClick={onClose} aria-hidden data-testid="modal-scrim" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cn(
          'relative flex max-h-[calc(100dvh-2rem)] w-full flex-col rounded-md border border-line bg-surface text-fg shadow-pop animate-fade-in focus:outline-none',
          MODAL_WIDTH[size],
        )}
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-sm font-semibold text-fg">{title}</h2>
            {description && <p id={descId} className="mt-0.5 text-xs text-fg-muted">{description}</p>}
          </div>
          <IconButton label="Close" size="sm" icon={<XIcon size={16} />} onClick={onClose} className="-mr-1" />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 440,
  side = 'right',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  side?: 'right' | 'left';
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogBehaviour(open, onClose, panelRef);
  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-[2000]">
      <div className="absolute inset-0 bg-scrim animate-fade-in" onClick={onClose} aria-hidden data-testid="drawer-scrim" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{ width: `min(${width}px, 100vw)` }}
        className={cn(
          'absolute inset-y-0 flex flex-col border-line bg-surface text-fg shadow-pop animate-fade-in focus:outline-none',
          side === 'right' ? 'right-0 border-l' : 'left-0 border-r',
        )}
      >
        <header className="flex h-13 shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-sm font-semibold text-fg">{title}</h2>
            {subtitle && <div className="mt-0.5 truncate text-xs text-fg-muted">{subtitle}</div>}
          </div>
          <IconButton label="Close" size="sm" icon={<XIcon size={16} />} onClick={onClose} />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
