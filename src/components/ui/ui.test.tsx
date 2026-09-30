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
    ['online', 'Online', 'text-emerald-400'],
    ['offline', 'Offline', 'text-red-400'],
    ['maintenance', 'Maintenance', 'text-amber-400'],
    ['critical', 'Critical', 'text-red-300'],
    ['info', 'Info', 'text-blue-400'],
  ] as const)('renders %s with default label and colour', (variant, label, cls) => {
    render(<StatusBadge variant={variant} />);
    expect(screen.getByText(label)).toHaveClass(cls);
  });

  it('uses custom label, size and pulse', () => {
    const { container } = render(<StatusBadge variant="high" label="Hot" size="md" pulse />);
    expect(screen.getByText('Hot')).toHaveClass('text-sm');
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
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
