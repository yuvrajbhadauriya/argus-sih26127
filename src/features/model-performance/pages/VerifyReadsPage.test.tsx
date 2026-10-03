import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { resetCameraEventsCache, resetDetectionsManifest } from '@/features/detections/api';
import { cropKey } from '../lib/cameraReads';
import { VERIFY_STORAGE_KEY, VerifyReadsPage } from './VerifyReadsPage';

const ev = (id: string, t: number, text: string) => ({ tracked_vehicle_id: id, plate_text: text, plate_confidence: 0.9, grammar_valid: true, time_sec: t });
const FILES: Record<string, unknown> = {
  '/detections/crops/manifest.json': { crops: { [cropKey('SC-01', 'a', 1)]: { plate: 'SC-01/a.jpg', vehicle: null }, [cropKey('SC-01', 'b', 2)]: { plate: 'SC-01/b.jpg', vehicle: null }, [cropKey('SC-01', 'c', 3)]: { plate: 'SC-01/c.jpg', vehicle: null } } },
  '/detections/manifest.json': { cameras: ['SC-01'] },
  '/detections/events_SC-01.json': { events: [ev('a', 1, 'AA11AA1111'), ev('b', 2, 'BB22BB2222'), ev('c', 3, 'CC33CC3333')] },
};

beforeEach(() => {
  localStorage.clear();
  resetDetectionsManifest();
  resetCameraEventsCache();
  vi.stubGlobal('fetch', vi.fn(async (u: string) => (FILES[u] ? { ok: true, status: 200, json: async () => FILES[u] } : { ok: false, status: 404, json: async () => ({}) })));
});
afterEach(() => vi.unstubAllGlobals());

const saved = () => JSON.parse(localStorage.getItem(VERIFY_STORAGE_KEY) ?? '{}');

describe('VerifyReadsPage (dev tool)', () => {
  it('marks reads with the keyboard (C, U, arrows), shows progress and keeps state in localStorage', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><VerifyReadsPage /></MemoryRouter>);
    expect(await screen.findByText(/Read 1 of 3 · 0 verified/)).toBeInTheDocument();
    expect(screen.getByTestId('verify-read')).toHaveTextContent('AA11AA1111');
    await user.keyboard('c');
    expect(await screen.findByText(/Read 2 of 3 · 1 verified/)).toBeInTheDocument();
    await user.keyboard('u');
    expect(await screen.findByText(/Read 3 of 3 · 2 verified/)).toBeInTheDocument();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByText(/Read 2 of 3/)).toBeInTheDocument();
    const labels = saved().labels;
    expect(labels[cropKey('SC-01', 'a', 1)]).toEqual({ verdict: 'correct' });
    expect(labels[cropKey('SC-01', 'b', 2)]).toEqual({ verdict: 'unreadable' });
  });

  it('Wrong takes the true plate (W focuses the input, Enter saves)', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><VerifyReadsPage /></MemoryRouter>);
    await screen.findByTestId('verify-read');
    await user.keyboard('w');
    expect(screen.getByPlaceholderText('e.g. MH12AB1234')).toHaveFocus();
    await user.keyboard('aa 11 ab 1111{Enter}');
    expect(saved().labels[cropKey('SC-01', 'a', 1)]).toEqual({ verdict: 'wrong', truth: 'AA11AB1111' });
    expect(await screen.findByText(/Read 2 of 3/)).toBeInTheDocument();
  });

  it('restores progress after a reload and downloads exactly the documented file', async () => {
    const user = userEvent.setup();
    const first = render(<MemoryRouter><VerifyReadsPage /></MemoryRouter>);
    await screen.findByTestId('verify-read');
    await user.keyboard('c');
    await user.type(screen.getByLabelText('Verified by'), 'Reviewer');
    first.unmount();
    render(<MemoryRouter><VerifyReadsPage /></MemoryRouter>);
    expect(await screen.findByText(/Read 2 of 3 · 1 verified/)).toBeInTheDocument();

    let blob: Blob | null = null;
    URL.createObjectURL = vi.fn((b: Blob | MediaSource) => ((blob = b as Blob), 'blob:x'));
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await user.click(screen.getByRole('button', { name: 'Download camera_reads_verified.json' }));
    expect(click).toHaveBeenCalled();
    const file = JSON.parse(await blob!.text());
    expect(Object.keys(file)).toEqual(['schema', 'verified_by', 'verified_at', 'labels']);
    expect(file).toMatchObject({ schema: 1, verified_by: 'Reviewer', labels: { [cropKey('SC-01', 'a', 1)]: { verdict: 'correct' } } });
    expect(typeof file.verified_at).toBe('string');
  });

  it('shows an empty state without crops', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    render(<MemoryRouter><VerifyReadsPage /></MemoryRouter>);
    expect(await screen.findByText('No crops to verify')).toBeInTheDocument();
  });
});
