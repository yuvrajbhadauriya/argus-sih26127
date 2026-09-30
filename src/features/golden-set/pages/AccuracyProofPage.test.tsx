import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AccuracyProofPage } from './AccuracyProofPage';
import { containsModelName } from '@/features/model-performance/lib/publicCopy';

const FIELDS = ['key', 'gt', 'pred', 'confidence', 'correct', 'grammar_valid', 'row_count', 'side', 'state_code', 'conditions', 'labelers', 'width', 'height', 'inference_ms', 'roundtrip_ms'];
const items = [
  ['k1', 'MH01AB1234', 'MH01AB1234', 99.1, 1, 1, 1, 'front', 'MH', ['day', 'hsrp-standard'], 2, 200, 45, 24, 26],
  ['k2', 'DL9CAU8026', 'DL9C4U8026', 73.1, 0, 0, 1, 'rear', 'DL', ['day'], 2, 190, 44, 25, 27],
  ['k3', 'HR26DR8834', 'HR26DR8834', 95, 1, 1, 2, 'rear', 'HR', ['night-ir', 'hsrp-standard'], 2, 120, 80, 23, 25],
];
const RESULTS = {
  set: 'ocr_golden_v1',
  set_hash: '34092aa38f2f70ab46eed6604b632be7974f35dc7db500e75c243911da8b8f69',
  measured_at: '2026-09-30T22:17:01+05:30',
  endpoint: 'POST /v1/ocr (live API, plate crop, production grammar)',
  total_images: 5,
  scored: 3,
  skipped: { unreadable: 2 },
  overall: { n: 3, correct: 2, accuracy: 0.6667 },
  breakdown: {
    'condition:day': { n: 2, correct: 1, accuracy: 0.5 },
    'condition:night-ir': { n: 1, correct: 1, accuracy: 1 },
    'rows:2': { n: 1, correct: 1, accuracy: 1 },
  },
  latency_ms: { p50: 24.4, p95: 33.3 },
  bucket: 'golden',
  prefix: 'ocr_golden_v1/',
  item_fields: FIELDS,
  items,
};

/** Serves the results file and the signing endpoint (signed URLs for every requested path). */
function renderPage(body: unknown = RESULTS, ok = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      if (String(input).startsWith('/api/media/sign')) {
        const paths = (new URL(String(input), 'http://x').searchParams.get('paths') ?? '').split(',');
        const urls = Object.fromEntries(paths.map((p) => [p, `https://proj.supabase.co/storage/v1/object/sign/golden/${p}?token=t`]));
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ urls, expires_in: 3600 }) });
      }
      return Promise.resolve({ ok, status: ok ? 200 : 404, json: () => Promise.resolve(body) });
    }),
  );
  return render(
    <MemoryRouter>
      <AccuracyProofPage />
    </MemoryRouter>,
  );
}

describe('AccuracyProofPage', () => {
  it('shows the headline from the file, the mistakes and the gallery', async () => {
    renderPage();
    expect(await screen.findByTestId('gs-accuracy')).toHaveTextContent('66.67%');
    expect(screen.getByText('2 correct')).toBeInTheDocument();
    expect(screen.getByText('1 wrong')).toBeInTheDocument();
    expect(screen.getByText(/Below PS target/)).toBeInTheDocument();
    expect(screen.getByText(/not a simulation/i)).toBeInTheDocument();
    expect(screen.getByText('24 ms')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'All 1 mistakes' })).toBeInTheDocument();
    expect(screen.getByText(/2 of 5 golden images are not scored/)).toBeInTheDocument();
    // crops come from the private bucket through signed URLs
    await waitFor(() => expect(document.querySelectorAll('img[src*="/object/sign/golden/ocr_golden_v1/k1.jpg?token="]').length).toBeGreaterThan(0));
    expect(document.querySelector('img[src*="/object/public/"]')).toBeNull();
    expect(containsModelName(document.body.textContent ?? '')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('filters the gallery and opens the drawer', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('gs-accuracy');
    const gallery = document.getElementById('gallery')!;
    await user.selectOptions(within(gallery).getByLabelText('Result'), 'wrong');
    expect(within(gallery).getByText(/^1 plate/)).toBeInTheDocument();
    await user.click(within(gallery).getByRole('button', { name: /Plate DL9CAU8026/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Does not match the human label')).toBeInTheDocument();
    expect(within(dialog).getByText('73.1%')).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('the reel types the read, then shows the verdict and counts it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    renderPage();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const reel = document.getElementById('live-proof')!;
    expect(within(reel).getByText(/Verified 0/)).toBeInTheDocument();
    // step until the first verdict is on screen (scan → typing → meter → verdict)
    for (let i = 0; i < 60 && !within(reel).queryByText('Matches the human label'); i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
    }
    expect(within(reel).getByText('Matches the human label')).toBeInTheDocument();
    expect(within(reel).getByText(/100\.0% correct so far/)).toBeInTheDocument();
    // pause stops it
    await act(async () => {
      within(reel).getByRole('button', { name: 'Pause' }).click();
    });
    expect(within(reel).getByRole('button', { name: 'Play' })).toBeInTheDocument();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows an error with retry when the file is missing', async () => {
    renderPage({}, false);
    expect(await screen.findByText('Results unavailable')).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});
