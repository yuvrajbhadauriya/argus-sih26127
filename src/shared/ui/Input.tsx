// ═══════════════════════════════════════════════════
// Form controls: Input, Select (native), Textarea, Field, Kbd, Toolbar
// ═══════════════════════════════════════════════════

import type { InputHTMLAttributes, ReactNode, Ref, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { ChevronDownIcon } from 'lucide-react';
import { cn } from '@/shared/lib/cn';

const CONTROL =
  'w-full rounded-sm border bg-surface text-[13px] text-fg placeholder:text-fg-subtle dark:bg-surface-2 ' +
  'transition-colors focus:border-primary focus:outline-none focus:ring-2 focus:ring-focus/25 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  icon?: ReactNode;
  mono?: boolean;
  uiSize?: 'sm' | 'md';
  invalid?: boolean;
  trailing?: ReactNode;
  ref?: Ref<HTMLInputElement>;
};

export function Input({ icon, mono = false, uiSize = 'md', invalid = false, trailing, className, ref, ...rest }: InputProps) {
  return (
    <div className={cn('relative flex min-w-0 items-center', className)}>
      {icon && (
        <span className="pointer-events-none absolute left-2.5 inline-flex text-fg-subtle [&>svg]:h-4 [&>svg]:w-4" aria-hidden>
          {icon}
        </span>
      )}
      <input
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          CONTROL,
          uiSize === 'sm' ? 'h-7' : 'h-8',
          icon ? 'pl-8' : 'pl-2.5',
          trailing ? 'pr-16' : 'pr-2.5',
          mono && 'font-mono tabular-nums',
          invalid ? 'border-danger' : 'border-line-strong',
        )}
        {...rest}
      />
      {trailing && <span className="absolute right-2 inline-flex items-center gap-1">{trailing}</span>}
    </div>
  );
}

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  icon?: ReactNode;
  uiSize?: 'sm' | 'md';
  /** Inline prefix label, e.g. "Zone". */
  label?: string;
};

export function Select({ icon, uiSize = 'md', label, className, children, ...rest }: SelectProps) {
  // The wrapper draws the control chrome so an inline label/icon never overlaps the value.
  return (
    <div
      className={cn(
        'relative inline-flex min-w-0 items-center rounded-sm border border-line-strong bg-surface text-[13px] text-fg transition-colors dark:bg-surface-2',
        'focus-within:border-primary focus-within:ring-2 focus-within:ring-focus/25',
        'has-[select:disabled]:cursor-not-allowed has-[select:disabled]:opacity-50',
        uiSize === 'sm' ? 'h-7' : 'h-8',
        className,
      )}
    >
      {(icon || label) && (
        <span className="pointer-events-none inline-flex shrink-0 items-center gap-1.5 pl-2.5 text-xs text-fg-subtle [&>span>svg]:h-3.5 [&>span>svg]:w-3.5">
          {icon && <span className="inline-flex" aria-hidden>{icon}</span>}
          {label && <span className="font-medium" aria-hidden>{label}</span>}
        </span>
      )}
      <select
        aria-label={rest['aria-label'] ?? label}
        className={cn(
          'h-full min-w-0 flex-1 cursor-pointer appearance-none truncate rounded-sm bg-transparent pr-8 text-[13px] text-fg focus:outline-none disabled:cursor-not-allowed',
          icon || label ? 'pl-1.5' : 'pl-2.5',
        )}
        {...rest}
      >
        {children}
      </select>
      <ChevronDownIcon size={14} className="pointer-events-none absolute right-2.5 text-fg-subtle" aria-hidden />
    </div>
  );
}

export function Textarea({ invalid = false, className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      aria-invalid={invalid || undefined}
      className={cn(CONTROL, 'min-h-20 px-2.5 py-1.5', invalid ? 'border-danger' : 'border-line-strong', className)}
      {...rest}
    />
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  required = false,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-fg-muted">
        {label}
        {required && <span className="ml-0.5 text-danger" aria-hidden>*</span>}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-danger" role="alert">{error}</p>
      ) : (
        hint && <p className="text-xs text-fg-subtle">{hint}</p>
      )}
    </div>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 items-center gap-0.5 rounded-xs border border-line bg-surface-2 px-1.5 font-mono text-2xs font-medium text-fg-subtle',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-center gap-2', className)}>{children}</div>;
}
