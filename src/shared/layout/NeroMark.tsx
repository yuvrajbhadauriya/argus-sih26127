// NeroMark — the NERO brand glyph (shield + camera aperture). Inherits currentColor.

export function NeroMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden className={className}>
      <path
        d="M12 2.5 19.5 5.5v5.8c0 4.6-3.2 8.3-7.5 9.7-4.3-1.4-7.5-5.1-7.5-9.7V5.5z"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="11" r="3.4" stroke="currentColor" strokeWidth="1.9" />
      <circle cx="12" cy="11" r="1.1" fill="currentColor" />
    </svg>
  );
}
