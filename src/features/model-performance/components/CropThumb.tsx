// A real crop image, or a clear "image unavailable" tile (missing / failed to load). Never a stand-in image.

import { useState } from 'react';
import { ImageOffIcon } from 'lucide-react';
import { cn } from '@/shared/lib/cn';

export function CropThumb({ src, alt, className }: { src: string | null; alt: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={cn('flex items-center justify-center overflow-hidden rounded-sm border border-line bg-canvas', className)}>
      {src && !failed ? (
        <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} className="max-h-full max-w-full object-contain" />
      ) : (
        <span className="flex flex-col items-center gap-0.5 px-1 text-center text-2xs leading-tight text-fg-subtle" role="img" aria-label="Image unavailable">
          <ImageOffIcon size={14} aria-hidden />
          <span aria-hidden>image unavailable</span>
        </span>
      )}
    </div>
  );
}
