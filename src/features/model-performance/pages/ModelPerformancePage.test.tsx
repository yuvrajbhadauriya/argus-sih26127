import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ModelPerformancePage } from './ModelPerformancePage';
import { resetCameraEventsCache, resetDetectionsManifest } from '@/features/detections/api';
import { containsModelName } from '../lib/publicCopy';

const read = (p: string) => JSON.parse(readFileSync(resolve(process.cwd(), p), 'utf8'));
const SAMPLE = read('src/features/model-performance/__fixtures__/sample-results.json');
const VIDEO = read('src/features/model-performance/__fixtures__/sample-video.json');

const measured = {
  ...SAMPLE,
  status: 'measured',
  note: 'measured against the configured model API',
  model: { engine: 'lpu_on_gpu', model_version: 'deim50k+raw35', api: 'live' },
  overall: { ...SAMPLE.overall, plates: 200, exact: 188, plate_accuracy: 0.94 },
};

function stubFetch(files: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).startsWith('/api/media/sign')) {
      const paths = (new URL(String(url), 'http://x').searchParams.get('paths') ?? '').split(',');
      const urls = Object.fromEntries(paths.map((p) => [p, `https://proj.supabase.co/storage/v1/object/sign/golden/${p}?token=t`]));
      return { ok: true, status: 200, json: async () => ({ urls, expires_in: 3600 }) };
    }
    const body = files[String(url)];
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  }));
}

const renderPage = () => render(<MemoryRouter><ModelPerformancePage /></MemoryRouter>);

const REAL_RESULTS = read('public/eval/results.json');
const REAL_GOLDEN = read('public/golden/results_golden_v1.json');
const REAL_VIDEO = read('public/eval/video_consistency.json');
const MANIFEST = read('public/detections/manifest.json');
const REAL_EVENTS: Record<string, unknown> = Object.fromEntries(
  (MANIFEST.cameras as string[]).map((c) => [`/detections/events_${c}.json`, read(`public/detections/events_${c}.json`)]),
);

beforeEach(() => {
  resetDetectionsManifest();
  resetCameraEventsCache();
});
afterEach(() => vi.unstubAllGlobals());

describe('ModelPerformancePage', () => {
  it('shows the sample-data state prominently and no pass/fail verdict', async () => {
    stubFetch({ '/eval/results.json': SAMPLE, '/eval/video_consistency.json': VIDEO });
    renderPage();
    expect(await screen.findByText(/Sample data — run the evaluation/)).toBeInTheDocument();
    expect(screen.getByText('Different domain - not comparable to the PS in-domain target')).toBeInTheDocument();
    expect(screen.queryByText('Meets target')).toBeNull();
    expect(screen.queryByText('Below target')).toBeNull();
    // KPI tiles, chart, tables, gallery, video
    expect(screen.getAllByText('Stress-test plate accuracy').length).toBeGreaterThan(0);
    expect(screen.getByText('Latency p95')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /accuracy by capture condition/i })).toBeInTheDocument();
    expect(screen.getByText('Synthetic rendered plates (plumbing test)')).toBeInTheDocument();
    expect(await screen.findByText('Golden-set crops unavailable')).toBeInTheDocument();
    const gallery = screen.getByRole('list', { name: 'Sample predictions' });
    expect(within(gallery).getAllByRole('listitem').length).toBe(SAMPLE.samples.length);
    expect(screen.getByText('Offline mock (noisy oracle)')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: /read stability per camera/i })).toBeInTheDocument();
    expect(screen.getByText(/status in the top bar/)).toBeInTheDocument();
  });

  it('never judges the out-of-domain stress test against the PS target', async () => {
    stubFetch({ '/eval/results.json': measured, '/api/health': { configured: true, reachable: true, latency_ms: 42 } });
    renderPage();
    expect(await screen.findByText('Different domain - not comparable to the PS in-domain target')).toBeInTheDocument();
    expect(screen.getByText(/Robustness: out-of-distribution stress test \(public internet images\)/)).toBeInTheDocument();
    expect(screen.getByText('94.0%')).toBeInTheDocument();
    expect(screen.queryByText('Meets target')).toBeNull();
    expect(screen.queryByText('Below target')).toBeNull();
    expect(screen.queryByText(/-?\d+\.\d pts/)).toBeNull();
    expect(screen.queryByText(/Sample data — run the evaluation/)).toBeNull();
    expect(screen.queryByText('deim50k+raw35')).toBeNull();
    expect(screen.getByText('Trained Indian-plate ANPR model')).toBeInTheDocument();
    expect(screen.getByText('Live ANPR API (GPU)')).toBeInTheDocument();
    expect(screen.getAllByText(/not measured by this harness|not re-measured by this dashboard/).length).toBeGreaterThan(0);
    expect(screen.getByText('No video run yet')).toBeInTheDocument();
    // golden set not published in this stub: headline degrades to an error state, rest still renders
    expect(await screen.findByText('Golden-set results unavailable')).toBeInTheDocument();
  });

  it('shows an error state when results are missing or malformed', async () => {
    stubFetch({ '/eval/results.json': { schema_version: 99, overall: {} } });
    renderPage();
    expect(await screen.findByText('Evaluation results unavailable')).toBeInTheDocument();
    expect(screen.getByText(/schema_version 99/)).toBeInTheDocument();
  });

  it('headlines the in-domain golden-set accuracy against the PS target, from the real published files', async () => {
    stubFetch({
      '/eval/results.json': REAL_RESULTS,
      '/golden/results_golden_v1.json': REAL_GOLDEN,
      '/eval/video_consistency.json': REAL_VIDEO,
      '/detections/manifest.json': MANIFEST,
      ...REAL_EVENTS,
    });
    const { container } = renderPage();
    const { n, correct } = REAL_GOLDEN.overall;
    const acc = (correct / n) * 100;
    expect(await screen.findByTestId('mp-golden-accuracy')).toHaveTextContent(acc.toFixed(2));
    expect(screen.getByText('PS target met')).toBeInTheDocument();
    const margin = acc - REAL_RESULTS.target.plate_accuracy * 100;
    expect(screen.getByTestId('mp-golden-margin')).toHaveTextContent(`+${margin.toFixed(2)} pts above the target`);
    expect(screen.getByText(`PS target: ${REAL_RESULTS.target.source}`)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`${REAL_GOLDEN.skipped.unreadable.toLocaleString('en-IN')} of ${REAL_GOLDEN.total_images.toLocaleString('en-IN')} images marked unreadable`))).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Accuracy Proof' })[0]).toHaveAttribute('href', '/accuracy');
    expect(screen.getByText('Accuracy by condition: in-domain golden set')).toBeInTheDocument();
    // stress test: its own section, numbers unchanged, neutral label, no verdict
    expect(screen.getByText(/Robustness: out-of-distribution stress test \(public internet images\)/)).toBeInTheDocument();
    expect(screen.getByText('Different domain - not comparable to the PS in-domain target')).toBeInTheDocument();
    expect(screen.getByText(`${(REAL_RESULTS.overall.plate_accuracy * 100).toFixed(1)}%`)).toBeInTheDocument();
    expect(screen.queryByText('Below target')).toBeNull();
    expect(screen.queryByText(/-22\.0 pts/)).toBeNull();
    expect(await screen.findByText(/End-to-end accuracy on the camera video has not been measured yet/)).toBeInTheDocument();
    expect(screen.getByText(/not an end-to-end measurement on camera video/)).toBeInTheDocument();
    // real reads: golden sample tiles + stress samples
    expect(screen.getByText('Real reads: crop → OCR')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Golden-set sample reads' })).getAllByRole('listitem')).toHaveLength(12);
    expect(screen.getByText(/Hard out-of-domain cases/)).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Sample predictions' })).getAllByRole('listitem')).toHaveLength(REAL_RESULTS.samples.length);
    // High-confidence read rate from the real event files.
    expect(await screen.findByRole('table', { name: /high-confidence read rate per camera/i })).toBeInTheDocument();
    expect(screen.getByText(/OCR confidence ≥ 80%/)).toBeInTheDocument();

    const text = container.textContent ?? '';
    const attrs = Array.from(container.querySelectorAll('[title],[aria-label],[alt]'))
      .map((el) => ['title', 'aria-label', 'alt'].map((a) => el.getAttribute(a) ?? '').join(' '))
      .join(' ');
    for (const s of [text, attrs]) {
      expect(containsModelName(s)).toBe(false);
      expect(s).not.toMatch(/DEIM|PARSeq|deim50k|raw35|YOLO|ocr_v9/i);
      expect(s).not.toMatch(/vehicle_class/i);
    }
  });

  it('shows a clear "image unavailable" tile when signing fails (never a fake image)', async () => {
    // own bucket name: signed URLs are cached per bucket across tests
    stubFetch({ '/eval/results.json': REAL_RESULTS, '/golden/results_golden_v1.json': { ...REAL_GOLDEN, bucket: 'golden-unsignable' } });
    const base = globalThis.fetch as unknown as (u: string) => Promise<unknown>;
    vi.stubGlobal('fetch', vi.fn(async (u: string) => (String(u).startsWith('/api/media/sign') ? { ok: false, status: 503, json: async () => ({}) } : base(u))));
    renderPage();
    const list = await screen.findByRole('list', { name: 'Golden-set sample reads' });
    expect((await within(list).findAllByRole('img', { name: 'Image unavailable' })).length).toBe(12);
    expect(within(list).queryAllByRole('img').every((i) => i.getAttribute('aria-label'))).toBe(true);
  });
});
