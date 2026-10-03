// Live plate reads of the selected feed, read in real time by the GPU ANPR
// model: every row shows the vehicle and the plate exactly as cropped from the
// frame the model analysed, next to the OCR text and confidence.
import { useNavigate } from 'react-router-dom';
import { ScanLineIcon } from 'lucide-react';
import type { Camera } from '@/types/camera';
import type { AlertPriority } from '@/types';
import { Panel } from '@/shared/ui/Card';
import { EmptyState } from '@/shared/ui/EmptyState';
import { PlateChip } from '@/shared/ui/PlateChip';
import { SeverityChip } from '@/shared/ui/SeverityChip';
import { formatIstTime } from '@/features/live-map/lib/time';
import { useWatchlistIndex } from '@/features/detections/hooks/useWatchlistKeys';
import { plateKey } from '@/features/detections/lib/log';
import { DISPLAY_READ_MIN_CONFIDENCE } from '@/features/detections/api';
import type { LiveAnprState } from '@/features/detections/hooks/useLiveAnpr';
import type { LivePlateRead } from '@/features/detections/remote/liveAnpr';
import { useNowSeconds } from '@/features/detections/hooks/useLiveReads';

const MIN_PCT = Math.round(DISPLAY_READ_MIN_CONFIDENCE * 100);

function Thumb({ src, alt, className }: { src: string | null | undefined; alt: string; className: string }) {
  if (!src) {
    return <span aria-hidden="true" className={`${className} flex items-center justify-center bg-surface-2 text-[9px] max-lg:text-2xs text-fg-subtle`}>no crop</span>;
  }
  return <img src={src} alt={alt} className={`${className} bg-surface-2 object-contain`} draggable={false} />;
}

function ReadRow({ read, onTrace, hit }: { read: LivePlateRead; onTrace: () => void; hit: AlertPriority | null }) {
  return (
    <li>
      <button
        type="button"
        onClick={onTrace}
        className="relative flex w-full items-center gap-3 border-b border-line px-3 py-2 text-left transition-colors hover:bg-surface-2 focus-visible:bg-surface-2"
        aria-label={`Trace ${read.plate}`}
      >
        {hit && <span className="absolute inset-y-0 left-0 w-0.5 bg-danger" aria-hidden="true" />}
        <Thumb src={read.vehicleCrop?.dataUrl} alt={`Vehicle ${read.plate}`} className="h-11 w-14 shrink-0 rounded-[3px] border border-line" />
        <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
          <Thumb src={read.plateCrop?.dataUrl} alt={`Plate crop for ${read.plate}`} className="h-8 max-w-full rounded-[2px] border border-line" />
          <span className="flex items-center gap-1.5">
            <PlateChip plate={read.plate} size="xs" flag={hit ? 'watchlist' : null} />
            {hit && <SeverityChip severity={hit} size="sm" />}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end leading-tight">
          <span className="font-mono text-2xs tabular-nums text-fg">{Math.round(read.confidence * 100)}%</span>
          <span className="font-mono text-2xs tabular-nums text-fg-subtle" title={`Seen in ${read.sightings} analysed frame${read.sightings === 1 ? '' : 's'}`}>
            {formatIstTime(read.at)}
          </span>
        </span>
      </button>
    </li>
  );
}

export function LiveGpuReads({ camera, live }: { camera: Camera; live: LiveAnprState }) {
  const navigate = useNavigate();
  const watch = useWatchlistIndex();
  useNowSeconds(live.reads.length > 0);

  return (
    <Panel
      flush
      title="Live plate reads"
      icon={<ScanLineIcon />}
      actions={
        <span
          className="inline-flex items-center gap-1.5 text-2xs tabular-nums text-fg-muted"
          title={`Frames of this feed analysed by the GPU model${live.modelVersion ? ` (${live.modelVersion})` : ''}`}
        >
          <span className="relative inline-flex h-2 w-2" aria-hidden="true">
            <span className="absolute inset-0 animate-ping rounded-full bg-success opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
          </span>
          GPU live · {live.frames} frames{live.latencyMs != null ? ` · ${live.latencyMs} ms` : ''}
        </span>
      }
    >
      {live.reads.length === 0 ? (
        <EmptyState
          compact
          icon={<ScanLineIcon size={20} />}
          title="Analysing live frames…"
          description={`No plate read yet at ≥ ${MIN_PCT} % with a valid format — reads appear here the moment the model gets one.`}
        />
      ) : (
        <ol aria-label={`Live plate reads at ${camera.name}, newest first`} className="max-h-[420px] overflow-y-auto" aria-live="polite">
          {live.reads.map((r) => (
            <ReadRow
              key={r.id}
              read={r}
              hit={watch.get(plateKey(r.plate)) ?? null}
              onTrace={() => navigate(`/vehicles?plate=${encodeURIComponent(r.key)}`)}
            />
          ))}
        </ol>
      )}
      <p className="border-t border-line px-3 py-2 text-2xs text-fg-subtle">
        Frames of this feed are sent to the GPU ANPR model about once a second. Each crop is the region the model read in that frame
        (OCR ≥ {MIN_PCT} %, valid Indian plate format).
      </p>
    </Panel>
  );
}
