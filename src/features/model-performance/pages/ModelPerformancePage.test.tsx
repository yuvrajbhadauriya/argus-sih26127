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
    const body = files[String(url)];
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  }));
}

const renderPage = () => render(<MemoryRouter><ModelPerformancePage /></MemoryRouter>);

const REAL_RESULTS = read('public/eval/results.json');
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
    expect(screen.getByText('Not measured')).toBeInTheDocument();
    expect(screen.queryByText('Meets target')).toBeNull();
    expect(screen.queryByText('Below target')).toBeNull();
    // KPI tiles, chart, tables, gallery, video
    expect(screen.getAllByText('Plate accuracy').length).toBeGreaterThan(0);
    expect(screen.getByText('Latency p95')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /accuracy by capture condition/i })).toBeInTheDocument();
    expect(screen.getByText('Synthetic rendered plates (plumbing test)')).toBeInTheDocument();
    const gallery = screen.getByRole('list', { name: 'Sample predictions' });
    expect(within(gallery).getAllByRole('listitem').length).toBe(SAMPLE.samples.length);
    expect(screen.getByText('Offline mock (noisy oracle)')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: /read stability per camera/i })).toBeInTheDocument();
    expect(screen.getByText(/status in the top bar/)).toBeInTheDocument();
  });

  it('shows a pass marker for measured results at or above 90%', async () => {
    stubFetch({ '/eval/results.json': measured, '/api/health': { configured: true, reachable: true, latency_ms: 42 } });
    renderPage();
    expect(await screen.findByText('Meets target')).toBeInTheDocument();
    expect(screen.getByText('94.0%')).toBeInTheDocument();
    expect(screen.queryByText(/Sample data — run the evaluation/)).toBeNull();
    expect(screen.queryByText('deim50k+raw35')).toBeNull();
    expect(screen.getByText('Trained Indian-plate ANPR model')).toBeInTheDocument();
    expect(screen.getByText('Live ANPR API (GPU)')).toBeInTheDocument();
    expect(screen.getAllByText(/not measured by this harness|not re-measured by this dashboard/).length).toBeGreaterThan(0);
    expect(screen.getByText('No video run yet')).toBeInTheDocument();
  });

  it('shows below-target when measured accuracy misses 90%', async () => {
    stubFetch({ '/eval/results.json': { ...measured, overall: { ...measured.overall, plate_accuracy: 0.82 } } });
    renderPage();
    expect(await screen.findByText('Below target')).toBeInTheDocument();
    expect(screen.getByText(/-8\.0 pts/)).toBeInTheDocument();
  });

  it('shows an error state when results are missing or malformed', async () => {
    stubFetch({ '/eval/results.json': { schema_version: 99, overall: {} } });
    renderPage();
    expect(await screen.findByText('Evaluation results unavailable')).toBeInTheDocument();
    expect(screen.getByText(/schema_version 99/)).toBeInTheDocument();
  });

  it('headlines the team OCR benchmark and never renders model architecture names (real published files)', async () => {
    stubFetch({
      '/eval/results.json': REAL_RESULTS,
      '/eval/video_consistency.json': REAL_VIDEO,
      '/detections/manifest.json': MANIFEST,
      ...REAL_EVENTS,
    });
    const { container } = renderPage();
    expect(await screen.findByText('Plate OCR accuracy (team golden set, measured)')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '98.87%' })).toHaveAttribute('href', '/accuracy');
    expect(screen.getByText(/1,403 \/ 1,419 plates exactly right/)).toBeInTheDocument();
    const team = screen.getByRole('list', { name: 'Team OCR benchmarks' });
    expect(within(team).getByText('96.4%')).toBeInTheDocument();
    expect(within(team).getByText('92.5%')).toBeInTheDocument();
    expect(await screen.findByText(/End-to-end accuracy on the camera video has not been measured yet/)).toBeInTheDocument();
    // Real measured end-to-end figure is kept as is.
    expect(screen.getByText('68.0%')).toBeInTheDocument();
    expect(screen.getByText(/Out-of-distribution stress test/)).toBeInTheDocument();
    // High-confidence read rate from the real event files.
    expect(await screen.findByRole('table', { name: /high-confidence read rate per camera/i })).toBeInTheDocument();
    expect(screen.getByText(/OCR confidence ≥ 80%/)).toBeInTheDocument();
    expect(screen.getByText(/Good read rate:/)).toBeInTheDocument();

    const text = container.textContent ?? '';
    const attrs = Array.from(container.querySelectorAll('[title],[aria-label],[alt]'))
      .map((el) => ['title', 'aria-label', 'alt'].map((a) => el.getAttribute(a) ?? '').join(' '))
      .join(' ');
    for (const s of [text, attrs]) {
      expect(containsModelName(s)).toBe(false);
      expect(s).not.toMatch(/DEIM|PARSeq|deim50k|raw35|YOLO|ocr_v9/i);
    }
  });
});
