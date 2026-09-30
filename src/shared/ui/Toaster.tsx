// ═══════════════════════════════════════════════════
// Toaster — renders toasts from the toast store (mounted once in the layout)
// ═══════════════════════════════════════════════════

import { useSyncExternalStore } from 'react';
import { CircleCheckIcon, CircleXIcon, InfoIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { IconButton } from './Button';
import { dismissToast, getToasts, subscribeToasts, type ToastTone } from './toast';

const ICON: Record<ToastTone, typeof InfoIcon> = {
  success: CircleCheckIcon,
  danger: CircleXIcon,
  warning: TriangleAlertIcon,
  info: InfoIcon,
};
const TONE: Record<ToastTone, string> = {
  success: 'text-success',
  danger: 'text-danger',
  warning: 'text-warning',
  info: 'text-info',
};

export function Toaster() {
  const items = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[2100] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2">
      {items.map((t) => {
        const Icon = ICON[t.tone];
        return (
          <div
            key={t.id}
            role={t.tone === 'danger' ? 'alert' : 'status'}
            aria-live={t.tone === 'danger' ? 'assertive' : 'polite'}
            className="pointer-events-auto flex items-start gap-2.5 rounded-md border border-line bg-surface p-3 text-fg shadow-pop animate-fade-in"
          >
            <Icon size={16} className={cn('mt-0.5 shrink-0', TONE[t.tone])} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold leading-[18px]">{t.title}</p>
              {t.description && <p className="mt-0.5 text-xs text-fg-muted">{t.description}</p>}
              {t.action && (
                <button
                  type="button"
                  className="mt-1.5 rounded-sm text-xs font-semibold text-primary hover:underline focus-visible:outline-2 focus-visible:outline-focus"
                  onClick={() => {
                    dismissToast(t.id);
                    t.action!.onClick();
                  }}
                >
                  {t.action.label}
                </button>
              )}
            </div>
            <IconButton size="sm" label="Dismiss notification" icon={<XIcon size={14} />} onClick={() => dismissToast(t.id)} className="-m-1" />
          </div>
        );
      })}
    </div>
  );
}
