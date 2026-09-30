// ═══════════════════════════════════════════════════
// Button / IconButton
// ═══════════════════════════════════════════════════

import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { LoaderCircleIcon } from 'lucide-react';
import { cn } from '@/shared/lib/cn';

export type { Tone } from './Badge';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
  size?: 'sm' | 'md';
  icon?: ReactNode;
  iconRight?: ReactNode;
  loading?: boolean;
  fullWidth?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

const VARIANT: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary: 'bg-primary-solid text-on-primary border border-transparent hover:bg-primary-solid-hover',
  secondary: 'bg-surface text-fg border border-line-strong hover:bg-surface-2',
  ghost: 'text-fg-muted border border-transparent hover:bg-surface-2 hover:text-fg',
  danger: 'bg-danger-solid text-white border border-transparent hover:opacity-90',
  success: 'bg-success/12 text-success border border-success/35 hover:bg-success/20',
};

const BASE =
  'relative inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-sm font-medium ' +
  'transition-colors duration-100 disabled:pointer-events-none disabled:opacity-50 ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus [&_svg]:shrink-0';

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconRight,
  loading = false,
  fullWidth = false,
  className,
  children,
  disabled,
  type = 'button',
  ref,
  ...rest
}: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      data-variant={variant}
      className={cn(
        BASE,
        VARIANT[variant],
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-[13px]',
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <LoaderCircleIcon size={14} className="animate-spin" aria-hidden /> : icon && <span className="inline-flex" aria-hidden>{icon}</span>}
      {children}
      {iconRight && <span className="inline-flex" aria-hidden>{iconRight}</span>}
    </button>
  );
}

export type IconButtonProps = Omit<ButtonProps, 'icon' | 'iconRight' | 'children'> & {
  label: string;
  icon: ReactNode;
  badge?: number;
};

export function IconButton({ label, icon, badge, variant = 'ghost', size = 'md', className, title, ...rest }: IconButtonProps) {
  return (
    <Button
      variant={variant}
      size={size}
      aria-label={label}
      title={title ?? label}
      className={cn(size === 'sm' ? 'h-7 w-7 px-0' : 'h-8 w-8 px-0', className)}
      {...rest}
    >
      <span className="inline-flex" aria-hidden>{icon}</span>
      {badge != null && badge > 0 && (
        <span
          className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger-solid px-1 text-[10px] font-semibold leading-none text-white tabular-nums ring-2 ring-surface"
          aria-hidden
        >
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </Button>
  );
}
