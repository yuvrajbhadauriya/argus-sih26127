// Detail drawer for one golden-set plate.

import { useMemo, type ReactNode } from 'react';
import { Drawer } from '@/shared/ui/Modal';
import { Badge } from '@/shared/ui/Badge';
import { conditionLabel, plateVariant, type GoldenItem, type GoldenResults } from '../lib/results';
import { diffMarks } from '../lib/diff';
import { useCropUrls } from '../lib/useCropUrls';
import { ConfidenceBar, CropImage, PlateRead, VerdictIcon } from './parts';

export function ItemDrawer({ r, item, onClose }: { r: GoldenResults; item: GoldenItem | null; onClose: () => void }) {
  const list = useMemo(() => (item ? [item] : []), [item]);
  const urls = useCropUrls(r, list);
  if (!item) return null;
  const v = plateVariant(item);
  const m = diffMarks(item.gt, item.pred);
  const index = r.items.indexOf(item);
  const rows: [string, ReactNode][] = [
    ['Side', <span key="s" className="capitalize">{item.side}</span>],
    ['Layout', item.rowCount === 2 ? 'Two-row plate' : 'Single-row plate'],
    ['State code', item.stateCode || '—'],
    ['Plate-format check', item.grammarValid ? 'Valid Indian format' : 'Not a valid format'],
    ['Labelled by', `${item.labelers} people`],
    ['Crop size', `${item.width} × ${item.height} px`],
    ['Model inference', item.inferenceMs != null ? `${item.inferenceMs.toFixed(1)} ms` : '—'],
    ['API round trip', item.roundtripMs != null ? `${item.roundtripMs.toFixed(1)} ms` : '—'],
    ['Image id', <span key="k" className="break-all font-mono text-2xs">{item.key}</span>],
  ];
  return (
    <Drawer open onClose={onClose} title={`Plate #${(index + 1).toLocaleString('en-IN')}`} subtitle={item.correct ? 'Read correctly' : 'Misread'} width={480}>
      <div className="space-y-4">
        <CropImage
          src={urls.url(item)}
          onBroken={() => urls.broken(item)}
          width={item.width}
          height={item.height}
          alt={`Plate crop labelled ${item.gt}`}
          eager
          className="aspect-[2.4/1] w-full rounded-md border border-line"
          imgClassName="h-full w-full p-3"
        />
        <div className="grid grid-cols-2 gap-3">
          <div className="min-w-0">
            <div className="mb-1 text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">Human label</div>
            <PlateRead text={item.gt} variant={v} size="md" marks={item.correct ? undefined : m.gt} label={`Human label ${item.gt}`} />
          </div>
          <div className="min-w-0">
            <div className="mb-1 text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">Model read</div>
            <PlateRead text={item.pred || '—'} variant={v} size="md" marks={item.correct ? undefined : m.pred} label={`Model read ${item.pred}`} />
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-md border border-line bg-surface-2 p-3">
          <VerdictIcon correct={item.correct} size="lg" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className={item.correct ? 'text-sm font-semibold text-success' : 'text-sm font-semibold text-danger'}>
              {item.correct ? 'Exact match with the human label' : 'Does not match the human label'}
            </div>
            <div className="flex items-center gap-2">
              <ConfidenceBar value={item.confidence} className="flex-1" />
              <span className="font-mono text-xs tabular-nums text-fg">{item.confidence.toFixed(1)}%</span>
            </div>
          </div>
        </div>
        {item.conditions.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {item.conditions.map((c) => (
              <Badge key={c} tone="info">{conditionLabel(c)}</Badge>
            ))}
          </div>
        )}
        <dl className="divide-y divide-line rounded-md border border-line text-xs">
          {rows.map(([k, val]) => (
            <div key={k} className="flex items-start justify-between gap-4 px-3 py-2">
              <dt className="shrink-0 text-fg-muted">{k}</dt>
              <dd className="min-w-0 text-right text-fg">{val}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Drawer>
  );
}
