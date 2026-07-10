// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
afterEach(() => cleanup());
import ErrorBoundary from '../app/components/ErrorBoundary';

function Bomb(): never {
  throw new Error('render kaboom');
}

describe('ErrorBoundary', () => {
  it('renders children normally when nothing throws', () => {
    render(<ErrorBoundary><p>all good</p></ErrorBoundary>);
    expect(screen.getByText('all good')).toBeInTheDocument();
  });

  it('catches a render error and shows a fallback instead of crashing', () => {
    // React logs the error to console.error during the render pass that's caught —
    // silence it here so the test output isn't noisy with an expected stack trace.
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<ErrorBoundary><Bomb /></ErrorBoundary>);

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('render kaboom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();

    consoleSpy.mockRestore();
  });

  it('shows a custom fallback title when provided', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ErrorBoundary fallbackTitle="Page crashed"><Bomb /></ErrorBoundary>);
    expect(screen.getByText('Page crashed')).toBeInTheDocument();
  });
});
