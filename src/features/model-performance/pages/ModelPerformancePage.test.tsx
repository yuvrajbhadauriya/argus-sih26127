import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ModelPerformancePage } from './ModelPerformancePage';

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
    expect(screen.getByText('health endpoint unavailable')).toBeInTheDocument();
  });

  it('shows a pass marker for measured results at or above 90%', async () => {
    stubFetch({ '/eval/results.json': measured, '/api/health': { configured: true, reachable: true, latency_ms: 42 } });
    renderPage();
    expect(await screen.findByText('Meets target')).toBeInTheDocument();
    expect(screen.getByText('94.0%')).toBeInTheDocument();
    expect(screen.queryByText(/Sample data — run the evaluation/)).toBeNull();
    expect(screen.getAllByText('deim50k+raw35').length).toBeGreaterThan(0);
    expect(screen.getByText('Live ANPR API (GPU)')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Model team benchmarks' })).toBeInTheDocument();
    expect(screen.getByText(/not measured by this harness/)).toBeInTheDocument();
    expect(screen.getByText(/reachable · 42 ms/)).toBeInTheDocument();
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
});
