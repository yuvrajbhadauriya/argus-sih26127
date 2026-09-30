// Small building blocks shared by the reel, gallery, drawer and mistakes list.

import type { CSSProperties } from 'react';
import { CheckIcon, ImageOffIcon, XIcon } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import type { PlateVariant } from '@/shared/lib/plate';
import { PLATE_COLORS, VIDEO_OVERLAY } from '@/shared/theme/tokens';
import { confidenceTone } from '../lib/results';

const PLATE_SIZE = {
  sm: 'h-6 px-1.5 text-[13px]',
  md: 'h-8 px-2 text-base',
  lg: 'h-11 px-3 text-2xl',
  xl: 'h-14 px-4 text-[28px] sm:h-16 sm:text-4xl',
} as const;

/**
 * The exact characters of a read (or label) on a number-plate background.
 * Unlike PlateChip it never reformats the text, so a misread is shown as-is;
 * `marks` highlights differing character positions, `caret` shows a typing cursor.
 */
export function PlateRead({
  text,
  variant = 'private',
  size = 'md',
  marks,
  caret = false,
  minChars,
  label,
  className,
}: {
  text: string;
  variant?: PlateVariant;
  size?: keyof typeof PLATE_SIZE;
  marks?: Set<number>;
  caret?: boolean;
  /** Reserve width for this many characters (no layout shift while typing). */
  minChars?: number;
  label?: string;
  className?: string;
}) {
  const colors = PLATE_COLORS[variant];
  const style: CSSProperties = {
    backgroundColor: colors.bg,
    color: colors.fg,
    borderColor: PLATE_COLORS.border,
    boxShadow: `inset 0 0 0 1px ${PLATE_COLORS.inset}`,
    minWidth: minChars ? `calc(${minChars}ch * 1.12 + 1.5rem)` : undefined,
  };
  return (
    <span
      role="img"
      aria-label={label ?? `Plate ${text || 'blank'}`}
      className={cn(
        'inline-flex shrink-0 items-center overflow-hidden rounded-[4px] border font-mono font-bold uppercase leading-none tracking-[0.12em] tabular-nums dark:ring-1 dark:ring-line-strong',
        PLATE_SIZE[size],
        className,
      )}
      style={style}
    >
      <span aria-hidden className="whitespace-nowrap">
        {[...text].map((ch, i) =>
          marks?.has(i) ? (
            <span key={i} className="rounded-[2px] bg-danger-solid px-[1px] text-white">{ch}</span>
          ) : (
            <span key={i}>{ch}</span>
          ),
        )}
        {caret && <span className="gs-caret ml-[1px] inline-block h-[0.9em] w-[0.08em] min-w-[2px] translate-y-[0.1em] bg-current align-baseline" />}
      </span>
    </span>
  );
}

/**
 * A plate crop on a dark backdrop inside a fixed box (no layout shift).
 * `src`: signed URL, `undefined` while it is being signed (quiet shimmer),
 * `null` when unavailable (neutral placeholder).
 */
export function CropImage({
  src,
  width,
  height,
  alt,
  className,
  imgClassName,
  eager = false,
  onBroken,
}: {
  src: string | null | undefined;
  width: number;
  height: number;
  alt: string;
  className?: string;
  imgClassName?: string;
  eager?: boolean;
  onBroken?: () => void;
}) {
  return (
    <div className={cn('relative flex items-center justify-center overflow-hidden', className)} style={{ backgroundColor: VIDEO_OVERLAY.frameBg }}>
      {src ? (
        <img
          key={src}
          src={src}
          width={width || undefined}
          height={height || undefined}
          alt={alt}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          draggable={false}
          onError={onBroken}
          className={cn('max-h-full max-w-full object-contain', imgClassName)}
        />
      ) : src === null ? (
        <span className="flex flex-col items-center gap-1 text-[10px] text-white/45" role="img" aria-label="Image unavailable">
          <ImageOffIcon size={16} aria-hidden />
          <span aria-hidden>image unavailable</span>
        </span>
      ) : (
        <span className="h-full w-full animate-pulse bg-white/5" aria-hidden />
      )}
    </div>
  );
}

const TONE_BG = { success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger' } as const;

/** Horizontal confidence bar (0–100). `fill` = shown fraction (animated by the caller). */
export function ConfidenceBar({ value, fill = value, className, thin = false }: { value: number; fill?: number; className?: string; thin?: boolean }) {
  return (
    <div
      className={cn('relative w-full overflow-hidden rounded-full bg-surface-3', thin ? 'h-1' : 'h-2', className)}
      role="meter"
      aria-label="Model confidence"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
    >
      <div className={cn('h-full rounded-full transition-[width] duration-500 ease-out', TONE_BG[confidenceTone(value)])} style={{ width: `${Math.max(0, Math.min(100, fill))}%` }} />
    </div>
  );
}

export function VerdictIcon({ correct, size = 'sm', className }: { correct: boolean; size?: 'sm' | 'lg'; className?: string }) {
  const big = size === 'lg';
  return (
    <span
      role="img"
      aria-label={correct ? 'Correct' : 'Wrong'}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full',
        big ? 'h-12 w-12' : 'h-5 w-5',
        correct ? (big ? 'bg-success text-white dark:text-canvas' : 'bg-success/12 text-success') : big ? 'bg-danger-solid text-white' : 'bg-danger/12 text-danger',
        className,
      )}
    >
      {correct ? <CheckIcon size={big ? 28 : 12} strokeWidth={big ? 3 : 2.5} /> : <XIcon size={big ? 28 : 12} strokeWidth={big ? 3 : 2.5} />}
    </span>
  );
}

/** Keyframes used by the page (scan line, caret, verdict pop); disabled under reduced motion. */
export function GoldenStyles() {
  return (
    <style>{`
@keyframes gs-scan { from { transform: translateX(-100%); } to { transform: translateX(0%); } }
@keyframes gs-blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
@keyframes gs-pop { 0% { transform: scale(.6); opacity: 0; } 70% { transform: scale(1.08); opacity: 1; } 100% { transform: scale(1); } }
.gs-caret { animation: gs-blink 0.9s step-end infinite; }
.gs-pop { animation: gs-pop 320ms cubic-bezier(.2,.8,.2,1) both; }
@media (prefers-reduced-motion: reduce) { .gs-caret, .gs-pop, .gs-scan { animation: none !important; } }
`}</style>
  );
}
