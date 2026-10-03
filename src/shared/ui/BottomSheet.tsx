// ═══════════════════════════════════════════════════
// BottomSheet — phone-first modal anchored to the bottom edge. Shares the
// Modal focus trap / Esc / scroll lock; respects the iOS home-indicator inset.
// ═══════════════════════════════════════════════════

import { useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { XIcon } from 'lucide-react';
import { IconButton } from './Button';
import { useDialogBehaviour } from './useDialogBehaviour';

export function BottomSheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogBehaviour(open, onClose, panelRef);
  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-[2000] flex items-end">
      <div className="absolute inset-0 bg-scrim animate-fade-in" onClick={onClose} aria-hidden data-testid="sheet-scrim" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative flex max-h-[85dvh] w-full flex-col rounded-t-lg border border-b-0 border-line bg-surface text-fg shadow-pop animate-fade-in focus:outline-none"
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-1.5">
          <h2 id={titleId} className="text-sm font-semibold text-fg">{title}</h2>
          <IconButton label="Close" icon={<XIcon size={18} />} onClick={onClose} className="-mr-2" />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
