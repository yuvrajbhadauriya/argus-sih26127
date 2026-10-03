import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ModelPerformancePage } from './ModelPerformancePage';
import { resetCameraEventsCache, resetDetectionsManifest } from '@/features/detections/api';
import { containsModelName } from '../lib/publicCopy';
import { cropKey } from '../lib/cameraReads';

const read = (p: string) => JSON.parse(readFileSync(resolve(process.cwd(), p), 'utf8'));
const REAL_RESULTS = read('public/eval/results.json');
const REAL_GOLDEN = read('public/golden/results_golden_v1.json');

/** Serves JSON files by URL (404 otherwise) and the media-signing endpoint. */
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

// Two camera-feed crops, with events, for the camera-feed section.
const CROPS = {
  crops: {
    [cropKey('SC-01', 'a', 5)]: { plate: 'SC-01/a.jpg', vehicle: 'SC-01/av.jpg' },
    [cropKey('SC-01', 'b', 9)]: { plate: 'SC-01/b.jpg', vehicle: null },
    [cropKey('SC-01', 'c', 12)]: { plate: 'SC-01/c.jpg', vehicle: null },
  },
};
const ev = (id: string, t: number, text: string, conf: number) => ({ tracked_vehicle_id: id, plate_text: text, plate_confidence: conf, grammar_valid: true, time_sec: t });
const CAMERA_FILES = {
  '/detections/crops/manifest.json': CROPS,
  '/detections/manifest.json': { cameras: ['SC-01'] },
  '/detections/events_SC-01.json': { events: [ev('a', 5, 'MH12AB1234', 0.91), ev('b', 9, 'MH12AB1235', 0.62), ev('c', 12, 'MH12AB1236', 0.8)] },
};

const renderPage = () => render(<MemoryRouter><ModelPerformancePage /></MemoryRouter>);
const FILES = { '/eval/results.json': REAL_RESULTS, '/golden/results_golden_v1.json': REAL_GOLDEN };

beforeEach(() => {
  resetDetectionsManifest();
  resetCameraEventsCache();
});
afterEach(() => vi.unstubAllGlobals());

describe('ModelPerformancePage', () => {
  it('headlines the in-domain golden-set accuracy against the PS target, from the real published files', async () => {
    stubFetch(FILES);
    const { container } = renderPage();
    const { n, correct } = REAL_GOLDEN.overall;
    const acc = (correct / n) * 100;
    expect(await screen.findByTestId('mp-golden-accuracy')).toHaveTextContent(acc.toFixed(2));
    expect(screen.getByText('PS target met')).toBeInTheDocument();
    const margin = acc - REAL_RESULTS.target.plate_accuracy * 100;
    expect(screen.getByTestId('mp-golden-margin')).toHaveTextContent(`+${margin.toFixed(2)} pts above the target`);
    expect(screen.getByText(`PS target: ${REAL_RESULTS.target.source}`)).toBeInTheDocument();
    expect(screen.getByTestId('mp-scope-note')).toHaveTextContent('Accuracy is measured on readable plates only (plates the reviewers could read); vehicles whose plate is not legible are not scored.');
    expect(screen.getByText(new RegExp(`${REAL_GOLDEN.skipped.unreadable.toLocaleString('en-IN')} of ${REAL_GOLDEN.total_images.toLocaleString('en-IN')} images marked unreadable`))).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Accuracy Proof' })[0]).toHaveAttribute('href', '/accuracy');
    expect(screen.getByText('Accuracy by condition: in-domain golden set')).toBeInTheDocument();
    expect(screen.getByText(/not an end-to-end measurement on camera video/)).toBeInTheDocument();
    expect(screen.getByText('Real reads: crop → OCR')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Golden-set sample reads' })).getAllByRole('listitem')).toHaveLength(12);
    expect(screen.getByText('Model card')).toBeInTheDocument();

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

  it('renders nothing of the out-of-distribution stress test or the read rate', async () => {
    stubFetch({ ...FILES, ...CAMERA_FILES, '/detections/events_SC-01.json': read('public/detections/events_SC-01.json') });
    const { container } = renderPage();
    await screen.findByTestId('mp-golden-accuracy');
    await screen.findByRole('list', { name: 'Camera feed reads' });
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/stress test|out-of-distribution|Limitations and robustness|different domain|High-confidence read rate|Per dataset|character errors|Video read stability|Below target|Meets target/i);
    expect(text).not.toContain(`${(REAL_RESULTS.overall.plate_accuracy * 100).toFixed(1)}%`);
    expect(container.querySelector('details')).toBeNull();
  });

  it('orders the sections: headline, camera feed, real reads, model card', async () => {
    stubFetch({ ...FILES, ...CAMERA_FILES });
    renderPage();
    await screen.findByRole('list', { name: 'Camera feed reads' });
    await screen.findByRole('list', { name: 'Golden-set sample reads' });
    const titles = ['Plate OCR accuracy: in-domain golden set', 'Camera feed: readable reads', 'Real reads: crop → OCR', 'Model card'].map((t) => screen.getByText(t));
    for (let i = 1; i < titles.length; i++) {
      expect(titles[i - 1].compareDocumentPosition(titles[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('shows the PS target as unavailable (no margin) when the evaluation file is missing, and still headlines the golden set', async () => {
    stubFetch({ '/golden/results_golden_v1.json': REAL_GOLDEN });
    renderPage();
    expect(await screen.findByTestId('mp-golden-accuracy')).toBeInTheDocument();
    expect(screen.getByText(/PS target unavailable/)).toBeInTheDocument();
    expect(screen.queryByTestId('mp-golden-margin')).toBeNull();
  });

  it('shows an error state for the headline when the golden set is missing', async () => {
    stubFetch({ '/eval/results.json': REAL_RESULTS });
    renderPage();
    expect(await screen.findByText('Golden-set results unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('mp-golden-accuracy')).toBeNull();
  });

  it('shows an "image unavailable" tile when signing fails (never a fake image)', async () => {
    stubFetch({ ...FILES, '/golden/results_golden_v1.json': { ...REAL_GOLDEN, bucket: 'golden-unsignable' } });
    const base = globalThis.fetch as unknown as (u: string) => Promise<unknown>;
    vi.stubGlobal('fetch', vi.fn(async (u: string) => (String(u).startsWith('/api/media/sign') ? { ok: false, status: 503, json: async () => ({}) } : base(u))));
    renderPage();
    const list = await screen.findByRole('list', { name: 'Golden-set sample reads' });
    expect((await within(list).findAllByRole('img', { name: 'Image unavailable' })).length).toBe(12);
  });
});

describe('Camera feed: readable reads', () => {
  it('lists the reads sorted by camera then confidence, labelled as unverified model confidence, with "Verification pending" and no accuracy', async () => {
    stubFetch({ ...FILES, ...CAMERA_FILES });
    renderPage();
    const list = await screen.findByRole('list', { name: 'Camera feed reads' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('aria-label'))).toEqual([
      'SC-01 at 0:05: read MH12AB1234',
      'SC-01 at 0:12: read MH12AB1236',
      'SC-01 at 0:09: read MH12AB1235',
    ]);
    expect(within(items[0]).getByText(/model confidence, not verified/)).toBeInTheDocument();
    expect(within(items[0]).getByText('91%')).toBeInTheDocument();
    expect(within(items[0]).getByRole('img', { name: /Vehicle crop/ })).toBeInTheDocument();
    expect(within(items[1]).queryByRole('img', { name: /Vehicle crop/ })).toBeNull();
    expect(screen.getByText('Verification pending')).toBeInTheDocument();
    expect(screen.queryByTestId('mp-verified-accuracy')).toBeNull();
    expect(screen.getByTestId('mp-camera-scope-note')).toHaveTextContent('readable plates only');
  });

  it('shows accuracy only from the human verification file: correct / (correct + wrong), unreadable excluded, with a Wilson interval and the counts', async () => {
    const verified = {
      schema: 1,
      verified_by: 'Reviewer One',
      verified_at: '2026-10-04',
      labels: {
        [cropKey('SC-01', 'a', 5)]: { verdict: 'correct' },
        [cropKey('SC-01', 'b', 9)]: { verdict: 'wrong', truth: 'MH12AB1299' },
        [cropKey('SC-01', 'c', 12)]: { verdict: 'unreadable' },
        'SC-01_gone_1': { verdict: 'wrong' }, // not a read on the page: ignored
      },
    };
    stubFetch({ ...FILES, ...CAMERA_FILES, '/eval/camera_reads_verified.json': verified });
    renderPage();
    expect(await screen.findByTestId('mp-verified-accuracy')).toHaveTextContent('50.0');
    expect(screen.getByTestId('mp-verified-counts')).toHaveTextContent('n = 2 verified: 1 correct, 1 wrong · 1 unreadable (not scored)');
    expect(screen.getByTestId('mp-verified-ci')).toHaveTextContent('9.5% to 90.5%');
    expect(screen.getByText(/Reviewer One/)).toBeInTheDocument();
    expect(screen.queryByText('Verification pending')).toBeNull();
  });

  it('shows no accuracy when every verified read is unreadable', async () => {
    const verified = { schema: 1, verified_by: 'R', verified_at: 'x', labels: { [cropKey('SC-01', 'a', 5)]: { verdict: 'unreadable' } } };
    stubFetch({ ...FILES, ...CAMERA_FILES, '/eval/camera_reads_verified.json': verified });
    renderPage();
    expect(await screen.findByText('Verification pending')).toBeInTheDocument();
    expect(screen.queryByTestId('mp-verified-accuracy')).toBeNull();
  });

  it('shows a clear empty state when the crop manifest is missing', async () => {
    stubFetch(FILES);
    renderPage();
    expect(await screen.findByText('No camera-feed crops published')).toBeInTheDocument();
    expect(screen.queryByText('Verification pending')).toBeNull();
    expect(screen.queryByTestId('mp-verified-accuracy')).toBeNull();
  });

  it('replaces a crop that fails to load with an "image unavailable" tile', async () => {
    stubFetch({ ...FILES, ...CAMERA_FILES });
    renderPage();
    const list = await screen.findByRole('list', { name: 'Camera feed reads' });
    const img = within(list).getAllByRole('img', { name: /Plate crop/ })[0];
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.error(img);
    expect(within(list).getAllByRole('img', { name: 'Image unavailable' }).length).toBeGreaterThan(0);
  });
});

describe('Camera feed: pagination', () => {
  it('pages through all reads (24 per page)', async () => {
    const crops: Record<string, unknown> = {};
    const events = [];
    for (let i = 0; i < 30; i++) {
      crops[cropKey('SC-01', `v${i}`, i)] = { plate: `SC-01/${i}.jpg`, vehicle: null };
      events.push(ev(`v${i}`, i, `MH12AB${1000 + i}`, 0.5 + i / 100));
    }
    stubFetch({ ...FILES, '/detections/crops/manifest.json': { crops }, '/detections/manifest.json': { cameras: ['SC-01'] }, '/detections/events_SC-01.json': { events } });
    renderPage();
    const list = await screen.findByRole('list', { name: 'Camera feed reads' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(24);
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: 'Next page of reads' }));
    expect(within(screen.getByRole('list', { name: 'Camera feed reads' })).getAllByRole('listitem')).toHaveLength(6);
  });
});
