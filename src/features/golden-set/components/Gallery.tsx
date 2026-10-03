// All scored plates: filterable, searchable, paginated grid of real crops.

import { useMemo, useState } from 'react';
import { ChevronLeftIcon, ChevronRightIcon, GalleryHorizontalEndIcon, SearchIcon, XIcon } from 'lucide-react';
import { Panel } from '@/shared/ui/Card';
import { Input, Select } from '@/shared/ui/Input';
import { Button, IconButton } from '@/shared/ui/Button';
import { EmptyState } from '@/shared/ui/EmptyState';
import {
  conditionOptions,
  DEFAULT_FILTERS,
  filterItems,
  fmtInt,
  plateVariant,
  summarize,
  type GalleryFilters,
  type GoldenItem,
  type GoldenResults,
} from '../lib/results';
import { diffMarks } from '../lib/diff';
import { useCropUrls, type CropUrls } from '../lib/useCropUrls';
import { ConfidenceBar, CropImage, PlateRead, VerdictIcon } from './parts';

export const PAGE_SIZE = 48;

/** One plate: crop, the model's read, confidence and verdict (`showTruth` adds the human label). */
export function Tile({ it, urls, onOpen, showTruth = false }: { it: GoldenItem; urls: CropUrls; onOpen: (it: GoldenItem) => void; showTruth?: boolean }) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(it)}
        className="flex w-full flex-col gap-1.5 rounded-md border border-line bg-surface p-2 text-left transition-colors hover:border-line-strong hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-focus"
        aria-label={`Plate ${it.gt}: read ${it.pred}, ${it.correct ? 'correct' : 'wrong'}, ${it.confidence.toFixed(0)}% confidence`}
      >
        <CropImage src={urls.url(it)} onBroken={() => urls.broken(it)} width={it.width} height={it.height} alt="" className="h-16 w-full rounded-sm" />
        <div className="flex items-center justify-between gap-1.5">
          <PlateRead text={it.pred || '—'} variant={plateVariant(it)} size="sm" marks={it.correct ? undefined : diffMarks(it.gt, it.pred).pred} className="min-w-0 max-w-full" />
          <VerdictIcon correct={it.correct} />
        </div>
        {showTruth && (
          <div className="flex items-center justify-between gap-1.5 text-2xs text-fg-subtle">
            <span>Label</span>
            <span className="min-w-0 truncate font-mono text-xs tracking-wide text-fg">{it.gt}</span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <ConfidenceBar value={it.confidence} thin className="flex-1" />
          <span className="font-mono text-2xs tabular-nums text-fg-muted">{it.confidence.toFixed(0)}%</span>
        </div>
      </button>
    </li>
  );
}

export function Gallery({ r, onOpen }: { r: GoldenResults; onOpen: (it: GoldenItem) => void }) {
  const [f, setF] = useState<GalleryFilters>(DEFAULT_FILTERS);
  const [page, setPage] = useState(0);
  const conditions = useMemo(() => conditionOptions(r.items), [r.items]);
  const filtered = useMemo(() => filterItems(r.items, f), [r.items, f]);
  const tally = useMemo(() => summarize(filtered), [filtered]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const cur = Math.min(page, pages - 1);
  const shown = useMemo(() => filtered.slice(cur * PAGE_SIZE, (cur + 1) * PAGE_SIZE), [filtered, cur]);
  const urls = useCropUrls(r, shown);
  const set = <K extends keyof GalleryFilters>(k: K, v: GalleryFilters[K]) => {
    setF((prev) => ({ ...prev, [k]: v }));
    setPage(0);
  };
  const dirty = JSON.stringify(f) !== JSON.stringify(DEFAULT_FILTERS);

  const pager = (
    <div className="flex items-center gap-1">
      <IconButton label="Previous page" size="sm" icon={<ChevronLeftIcon size={16} />} disabled={cur === 0} onClick={() => setPage(cur - 1)} />
      <span className="min-w-[64px] text-center text-xs tabular-nums text-fg-muted">
        {cur + 1} / {pages}
      </span>
      <IconButton label="Next page" size="sm" icon={<ChevronRightIcon size={16} />} disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)} />
    </div>
  );

  return (
    <Panel id="gallery" title="Every plate in the set" subtitle={`${fmtInt(r.items.length)} scored crops`} icon={<GalleryHorizontalEndIcon />} actions={pager} className="scroll-mt-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          icon={<SearchIcon />}
          placeholder="Search plate, e.g. MH01"
          aria-label="Search by plate"
          value={f.query}
          onChange={(e) => set('query', e.target.value)}
          mono
          className="w-full sm:w-52"
        />
        <Select label="Condition" value={f.condition} onChange={(e) => set('condition', e.target.value)} uiSize="md">
          <option value="">Any</option>
          {conditions.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label} ({c.count})
            </option>
          ))}
        </Select>
        <Select label="Rows" value={f.rows} onChange={(e) => set('rows', e.target.value as GalleryFilters['rows'])}>
          <option value="">Any</option>
          <option value="1">1 row</option>
          <option value="2">2 rows</option>
        </Select>
        <Select label="Side" value={f.side} onChange={(e) => set('side', e.target.value as GalleryFilters['side'])}>
          <option value="">Any</option>
          <option value="front">Front</option>
          <option value="rear">Rear</option>
        </Select>
        <Select label="Result" value={f.result} onChange={(e) => set('result', e.target.value as GalleryFilters['result'])}>
          <option value="">Any</option>
          <option value="correct">Correct</option>
          <option value="wrong">Wrong</option>
        </Select>
        <Select label="Confidence" value={f.confidence} onChange={(e) => set('confidence', e.target.value as GalleryFilters['confidence'])}>
          <option value="">Any</option>
          <option value="ge90">≥ 90%</option>
          <option value="75to90">75–90%</option>
          <option value="lt75">&lt; 75%</option>
        </Select>
        <Select label="Sort" value={f.sort} onChange={(e) => set('sort', e.target.value as GalleryFilters['sort'])}>
          <option value="default">Set order</option>
          <option value="confidence-asc">Lowest confidence</option>
          <option value="confidence-desc">Highest confidence</option>
        </Select>
        {dirty && (
          <Button size="sm" variant="ghost" icon={<XIcon size={13} />} onClick={() => (setF(DEFAULT_FILTERS), setPage(0))}>
            Clear
          </Button>
        )}
      </div>
      <p className="mb-3 text-xs tabular-nums text-fg-muted" aria-live="polite">
        {fmtInt(filtered.length)} plate{filtered.length === 1 ? '' : 's'}
        {filtered.length > 0 && (
          <>
            {' '}· {fmtInt(tally.correct)} correct · <span className="font-semibold text-fg">{((tally.correct / tally.n) * 100).toFixed(1)}%</span> accuracy
            {filtered.length > PAGE_SIZE && ` · showing ${fmtInt(cur * PAGE_SIZE + 1)}–${fmtInt(cur * PAGE_SIZE + shown.length)}`}
          </>
        )}
      </p>
      {shown.length ? (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {shown.map((it) => (
            <Tile key={it.key} it={it} urls={urls} onOpen={onOpen} />
          ))}
        </ul>
      ) : (
        <EmptyState compact title="No plates match" description="Try a different search or clear the filters." />
      )}
      {pages > 1 && <div className="mt-3 flex justify-end">{pager}</div>}
    </Panel>
  );
}
