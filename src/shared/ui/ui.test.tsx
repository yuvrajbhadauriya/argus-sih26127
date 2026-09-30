import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StatusBadge } from './StatusBadge';
import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';
import { LoadingState } from './LoadingState';
import { Card } from './Card';

describe('StatusBadge', () => {
  it.each([
    ['online', 'Online', 'data-status'],
    ['offline', 'Offline', 'data-status'],
    ['maintenance', 'Maintenance', 'data-status'],
    ['critical', 'Critical', 'data-severity'],
    ['high', 'High', 'data-severity'],
  ] as const)('renders %s with default label and semantic attribute', (variant, label, attr) => {
    const { container } = render(<StatusBadge variant={variant} />);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(container.querySelector(`[data-variant="${variant}"]`)).not.toBeNull();
    expect(container.querySelector(`[${attr}="${variant}"]`)).not.toBeNull();
  });

  it('renders info as an info-toned badge', () => {
    const { container } = render(<StatusBadge variant="info" />);
    expect(screen.getByText('Info')).toBeInTheDocument();
    expect(container.querySelector('[data-tone="info"]')).not.toBeNull();
  });

  it('uses custom label and pulse', () => {
    const { container } = render(<StatusBadge variant="online" label="Streaming" size="md" pulse />);
    expect(screen.getByText('Streaming')).toBeInTheDocument();
    expect(container.querySelector('.animate-live-pulse')).not.toBeNull();
  });
});

describe('EmptyState / ErrorState / LoadingState', () => {
  it('EmptyState renders title, description and action', () => {
    render(<EmptyState title="Nothing" description="desc" action={<button>Go</button>} />);
    expect(screen.getByRole('heading', { name: 'Nothing' })).toBeInTheDocument();
    expect(screen.getByText('desc')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go' })).toBeInTheDocument();
  });

  it('EmptyState omits optional parts', () => {
    render(<EmptyState title="Only title" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('ErrorState shows default message and no retry button by default', () => {
    render(<ErrorState />);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('ErrorState retry invokes callback', async () => {
    const onRetry = vi.fn();
    render(<ErrorState message="Oops" onRetry={onRetry} />);
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('LoadingState shows message', () => {
    render(<LoadingState message="Wait" />);
    expect(screen.getByText('Wait')).toBeInTheDocument();
  });
});

describe('Card', () => {
  it('is a keyboard-accessible button only when clickable', async () => {
    const onClick = vi.fn();
    const { rerender } = render(<Card>plain</Card>);
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<Card onClick={onClick}>click</Card>);
    const btn = screen.getByRole('button');
    btn.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(2);
  });
});
