// ═══════════════════════════════════════════════════
// GlobalPlateSearch — topbar plate lookup. Ctrl/Cmd+K or "/" focuses it;
// Enter opens Vehicle Trace for the normalised plate; Esc clears and blurs.
// ═══════════════════════════════════════════════════

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CommandIcon, SearchIcon } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { normalizePlate } from '@/shared/lib/plate';
import { Input, Kbd } from '@/shared/ui/Input';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');

function isNarrow(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 639px)').matches;
  } catch {
    return false;
  }
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

export function GlobalPlateSearch({ className }: { className?: string }) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      } else if (e.key === '/' && !isTypingTarget(e.target)) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <form
      role="search"
      className={cn('w-full min-w-[140px] max-w-[360px]', className)}
      onSubmit={(e) => {
        e.preventDefault();
        const plate = normalizePlate(value);
        if (!plate) return;
        navigate('/vehicles?plate=' + encodeURIComponent(plate));
        inputRef.current?.blur();
      }}
    >
      <Input
        ref={inputRef}
        id="global-search"
        type="search"
        mono
        value={value}
        onChange={(e) => setValue(e.target.value.toUpperCase())}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setValue('');
            e.currentTarget.blur();
          }
        }}
        placeholder={isNarrow() ? 'Search plate' : 'Search plate — e.g. DL 04 RS 9598'}
        aria-label="Search vehicle plate"
        autoComplete="off"
        spellCheck={false}
        icon={<SearchIcon size={16} strokeWidth={1.75} />}
        className="w-full max-md:[&_input]:pr-2.5 [&_input]:uppercase [&_input]:placeholder:normal-case [&_input]:placeholder:font-sans"
        trailing={
          <Kbd className="hidden md:inline-flex">
            {isMac ? <CommandIcon size={12} aria-label="Command" /> : 'Ctrl'}
            {isMac ? 'K' : ' K'}
          </Kbd>
        }
      />
    </form>
  );
}
