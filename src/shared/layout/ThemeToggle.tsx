// ═══════════════════════════════════════════════════
// ThemeToggle — icon button (topbar) or Light/Dark/System segmented control
// ═══════════════════════════════════════════════════

import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { IconButton } from '@/shared/ui/Button';
import { useTheme, type ThemePreference } from '@/shared/theme/theme';

const OPTIONS: { id: ThemePreference; label: string; Icon: typeof SunIcon }[] = [
  { id: 'light', label: 'Light', Icon: SunIcon },
  { id: 'dark', label: 'Dark', Icon: MoonIcon },
  { id: 'system', label: 'System', Icon: MonitorIcon },
];

export function ThemeToggle({ variant = 'icon', className }: { variant?: 'icon' | 'segmented'; className?: string }) {
  const { preference, resolved, setPreference, toggle } = useTheme();

  if (variant === 'segmented') {
    return (
      <div role="radiogroup" aria-label="Theme" className={cn('inline-flex gap-0.5 rounded-sm bg-surface-2 p-0.5', className)}>
        {OPTIONS.map(({ id, label, Icon }) => {
          const checked = preference === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={checked}
              onClick={() => setPreference(id)}
              className={cn(
                'inline-flex h-6 items-center gap-1.5 rounded-xs px-2 text-xs font-medium transition-colors',
                checked ? 'bg-surface text-fg shadow-sm dark:bg-surface-3' : 'text-fg-muted hover:text-fg',
              )}
            >
              <Icon size={14} strokeWidth={1.75} aria-hidden />
              {label}
            </button>
          );
        })}
      </div>
    );
  }

  const next = resolved === 'dark' ? 'light' : 'dark';
  const label = `Switch to ${next} theme`;
  return (
    <IconButton
      label={label}
      title={preference === 'system' ? `${label} (following system)` : label}
      icon={resolved === 'dark' ? <SunIcon size={18} strokeWidth={1.75} /> : <MoonIcon size={18} strokeWidth={1.75} />}
      onClick={toggle}
      className={className}
    />
  );
}
