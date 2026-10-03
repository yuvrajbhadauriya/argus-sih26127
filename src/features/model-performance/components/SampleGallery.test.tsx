import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SampleGallery } from './SampleGallery';
import type { SamplePrediction } from '../lib/results';

const s = (o: Partial<SamplePrediction>): SamplePrediction => ({
  id: 'a', dataset: 'hf-plate-crops', gt: 'MH12SF3212', pred: 'MH12SF322', correct: false, lenient_correct: false, edits: 1, confidence: 0.723, conditions: [], thumb: null, ...o,
});

describe('SampleGallery', () => {
  it('shows an "image unavailable" tile when there is no thumbnail, with truth, read and confidence', () => {
    render(<SampleGallery samples={[s({})]} />);
    expect(screen.getByRole('img', { name: 'Image unavailable' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /Plate crop/ })).toBeNull();
    expect(screen.getByText('MH12SF3212')).toBeInTheDocument();
    expect(screen.getByText('72%')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Incorrect' })).toBeInTheDocument();
  });
  it('swaps a thumbnail that fails to load for the unavailable tile', () => {
    render(<SampleGallery samples={[s({ thumb: '/x.jpg' })]} />);
    fireEvent.error(screen.getByRole('img', { name: /Plate crop, ground truth MH12SF3212/ }));
    expect(screen.getByRole('img', { name: 'Image unavailable' })).toBeInTheDocument();
  });
});
