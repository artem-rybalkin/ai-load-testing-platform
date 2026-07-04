// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
afterEach(() => cleanup());
import ActiveTests from '../app/components/ActiveTests';

const mockUseHealth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/HealthContext', () => ({ useHealth: mockUseHealth }));

vi.mock('react-router-dom', () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={String(to)} {...(props as React.HTMLAttributes<HTMLAnchorElement>)}>{children}</a>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ActiveTests', () => {
  it('renders nothing when there are no active tests', () => {
    mockUseHealth.mockReturnValue({ services: [], activeTests: [] });
    const { container } = render(<ActiveTests />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the count of running tests', () => {
    mockUseHealth.mockReturnValue({
      services: [],
      activeTests: [
        { test_id: 'id-1', type: 'backend', target_url: 'http://api.example.com', status: 'running', created_at: new Date().toISOString() },
      ],
    });
    render(<ActiveTests />);
    expect(screen.getByText(/1 test running/)).toBeInTheDocument();
  });

  it('shows plural "tests running" for multiple active tests', () => {
    mockUseHealth.mockReturnValue({
      services: [],
      activeTests: [
        { test_id: 'id-1', type: 'backend', target_url: 'http://a.com', status: 'running', created_at: new Date().toISOString() },
        { test_id: 'id-2', type: 'client-side', target_url: 'http://b.com', status: 'pending', created_at: new Date().toISOString() },
      ],
    });
    render(<ActiveTests />);
    expect(screen.getByText(/2 tests running/)).toBeInTheDocument();
  });

  it('renders a link to each active test result page', () => {
    mockUseHealth.mockReturnValue({
      services: [],
      activeTests: [
        { test_id: 'abc-123', type: 'backend', target_url: 'http://api.example.com', status: 'running', created_at: new Date().toISOString() },
      ],
    });
    render(<ActiveTests />);
    const link = screen.getByRole('link', { name: /api\.example\.com/ });
    expect(link).toHaveAttribute('href', '/results/abc-123');
  });

  it('strips protocol from displayed URL', () => {
    mockUseHealth.mockReturnValue({
      services: [],
      activeTests: [
        { test_id: 'id-1', type: 'backend', target_url: 'https://secure.example.com', status: 'running', created_at: new Date().toISOString() },
      ],
    });
    render(<ActiveTests />);
    expect(screen.getByText(/secure\.example\.com/)).toBeInTheDocument();
  });
});
