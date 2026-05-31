// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
afterEach(() => cleanup());
import ActiveTests from '../app/components/ActiveTests';

vi.mock('@/lib/api', () => ({
  getActiveTests: vi.fn(),
}));

vi.mock('react-router-dom', () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={String(to)} {...(props as React.HTMLAttributes<HTMLAnchorElement>)}>{children}</a>
  ),
}));

import { getActiveTests } from '@/lib/api';
const mockGetActiveTests = vi.mocked(getActiveTests);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ActiveTests', () => {
  it('renders nothing when there are no active tests', async () => {
    mockGetActiveTests.mockResolvedValue({ active: [] });
    const { container } = render(<ActiveTests />);
    // Let the useEffect run and update state
    await waitFor(() => expect(mockGetActiveTests).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it('shows the count of running tests', async () => {
    mockGetActiveTests.mockResolvedValue({
      active: [
        { test_id: 'id-1', type: 'backend', target_url: 'http://api.example.com', status: 'running', created_at: new Date().toISOString() },
      ],
    });
    render(<ActiveTests />);
    await waitFor(() => expect(screen.getByText(/1 test running/)).toBeInTheDocument());
  });

  it('shows plural "tests running" for multiple active tests', async () => {
    mockGetActiveTests.mockResolvedValue({
      active: [
        { test_id: 'id-1', type: 'backend', target_url: 'http://a.com', status: 'running', created_at: new Date().toISOString() },
        { test_id: 'id-2', type: 'client-side', target_url: 'http://b.com', status: 'pending', created_at: new Date().toISOString() },
      ],
    });
    render(<ActiveTests />);
    await waitFor(() => expect(screen.getByText(/2 tests running/)).toBeInTheDocument());
  });

  it('renders a link to each active test result page', async () => {
    mockGetActiveTests.mockResolvedValue({
      active: [
        { test_id: 'abc-123', type: 'backend', target_url: 'http://api.example.com', status: 'running', created_at: new Date().toISOString() },
      ],
    });
    render(<ActiveTests />);
    await waitFor(() => {
      const link = screen.getByRole('link', { name: /api\.example\.com/ });
      expect(link).toHaveAttribute('href', '/results/abc-123');
    });
  });

  it('strips protocol from displayed URL', async () => {
    mockGetActiveTests.mockResolvedValue({
      active: [
        { test_id: 'id-1', type: 'backend', target_url: 'https://secure.example.com', status: 'running', created_at: new Date().toISOString() },
      ],
    });
    render(<ActiveTests />);
    await waitFor(() => expect(screen.getByText(/secure\.example\.com/)).toBeInTheDocument());
  });

  it('renders nothing when getActiveTests throws', async () => {
    mockGetActiveTests.mockRejectedValue(new Error('network error'));
    const { container } = render(<ActiveTests />);
    await waitFor(() => expect(mockGetActiveTests).toHaveBeenCalled());
    // Component silently ignores errors — still renders null for empty list
    expect(container.firstChild).toBeNull();
  });
});
