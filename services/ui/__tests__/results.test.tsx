// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import ResultsPage from '../app/results/page';

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.ComponentProps<'a'>) => (
    <a href={href as string} {...props}>{children}</a>
  ),
}));

vi.mock('@/lib/api', () => ({
  getResults: vi.fn(),
}));

import { getResults } from '@/lib/api';
const mockGetResults = vi.mocked(getResults);

const makeResult = (id: string, status = 'completed') => ({
  id: `row-${id}`,
  test_id: id,
  type: 'backend',
  target_url: `http://example-${id}.com`,
  status,
  metrics: { rps: 10, p95ResponseTime: 400 },
  script: null,
  script_description: null,
  reused_script: false,
  is_baseline: false,
  duration_seconds: 30,
  started_at: new Date().toISOString(),
  completed_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  perf_status: 'passed',
});

beforeEach(() => {
  vi.clearAllMocks();
  mockPush.mockReset();
});

afterEach(() => cleanup());

describe('Results page', () => {
  it('shows "No results yet" when the results list is empty', async () => {
    mockGetResults.mockResolvedValue({ results: [] });
    render(<ResultsPage />);
    await waitFor(() => expect(screen.getByText('No results yet')).toBeInTheDocument());
  });

  it('renders a row for each result', async () => {
    mockGetResults.mockResolvedValue({
      results: [makeResult('aaa'), makeResult('bbb')],
    });
    render(<ResultsPage />);
    await waitFor(() => {
      expect(screen.getByText('http://example-aaa.com')).toBeInTheDocument();
      expect(screen.getByText('http://example-bbb.com')).toBeInTheDocument();
    });
  });

  it('compare button does not appear when fewer than 2 items are selected', async () => {
    mockGetResults.mockResolvedValue({ results: [makeResult('aaa')] });
    render(<ResultsPage />);
    await waitFor(() => screen.getByText('http://example-aaa.com'));
    const [checkbox] = screen.getAllByRole('checkbox');
    fireEvent.click(checkbox);
    expect(screen.queryByRole('button', { name: /compare selected/i })).not.toBeInTheDocument();
    expect(screen.getByText(/select one more to compare/i)).toBeInTheDocument();
  });

  it('shows compare button and navigates when 2 results are selected', async () => {
    mockGetResults.mockResolvedValue({
      results: [makeResult('aaa'), makeResult('bbb')],
    });
    render(<ResultsPage />);
    await waitFor(() => screen.getAllByRole('checkbox'));
    const [cb1, cb2] = screen.getAllByRole('checkbox');
    fireEvent.click(cb1);
    fireEvent.click(cb2);
    const compareBtn = await screen.findByRole('button', { name: /compare selected/i });
    fireEvent.click(compareBtn);
    expect(mockPush).toHaveBeenCalledWith(
      expect.stringContaining('/results/compare?a=')
    );
  });

  it('does not show checkbox for non-completed results', async () => {
    mockGetResults.mockResolvedValue({
      results: [makeResult('aaa', 'running')],
    });
    render(<ResultsPage />);
    await waitFor(() => screen.getByText('http://example-aaa.com'));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('shows a link to the individual result detail page', async () => {
    mockGetResults.mockResolvedValue({ results: [makeResult('test-id-xyz')] });
    render(<ResultsPage />);
    await waitFor(() => {
      const link = screen.getByRole('link', { name: /view/i });
      expect(link).toHaveAttribute('href', '/results/test-id-xyz');
    });
  });

  it('shows Re-run buttons for completed results (desktop + mobile)', async () => {
    mockGetResults.mockResolvedValue({ results: [makeResult('aaa', 'completed')] });
    render(<ResultsPage />);
    await waitFor(() => expect(screen.getByText('http://example-aaa.com')).toBeInTheDocument());
    // jsdom renders both the hidden-md desktop table and the md:hidden mobile cards,
    // so we expect at least one Re-run button (could be two — one per layout).
    expect(screen.getAllByRole('button', { name: /re-run/i }).length).toBeGreaterThan(0);
  });

  it('Re-run button navigates to home with the rerun query param', async () => {
    mockGetResults.mockResolvedValue({ results: [makeResult('aaa', 'completed')] });
    render(<ResultsPage />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: /re-run/i }).length).toBeGreaterThan(0));
    // Click the first Re-run button (desktop table version)
    fireEvent.click(screen.getAllByRole('button', { name: /re-run/i })[0]);
    expect(mockPush).toHaveBeenCalledWith('/?rerun=aaa');
  });

  it('does not show a Re-run button for non-completed results', async () => {
    mockGetResults.mockResolvedValue({ results: [makeResult('aaa', 'running')] });
    render(<ResultsPage />);
    await waitFor(() => expect(screen.getByText('http://example-aaa.com')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /re-run/i })).not.toBeInTheDocument();
  });
});
