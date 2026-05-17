// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import Home from '../app/page';

// vi.hoisted ensures these are available even after vi.mock is hoisted
const mockPush = vi.hoisted(() => vi.fn());
const stableSearchParams = vi.hoisted(() => new URLSearchParams());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  // Return the SAME URLSearchParams instance every call so useEffect deps stay stable
  useSearchParams: () => stableSearchParams,
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.ComponentProps<'a'>) => (
    <a href={href as string} {...props}>{children}</a>
  ),
}));

vi.mock('@/lib/api', () => ({
  createTest: vi.fn().mockResolvedValue({ test: { id: 'new-test-id' } }),
  getTemplates: vi.fn().mockResolvedValue({ templates: [] }),
  createTemplate: vi.fn().mockResolvedValue({}),
  getResults: vi.fn().mockResolvedValue({ results: [] }),
  getActiveTests: vi.fn().mockResolvedValue({ active: [] }),
}));

import { createTest, getTemplates } from '@/lib/api';
const mockCreateTest = vi.mocked(createTest);
const mockGetTemplates = vi.mocked(getTemplates);

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateTest.mockResolvedValue({ test: { id: 'new-test-id' } });
  mockGetTemplates.mockResolvedValue({ templates: [] });
});

afterEach(() => cleanup());

describe('Home page — form validation', () => {
  it('shows URL required error when submitted without a URL', async () => {
    render(<Home />);
    const runButton = screen.getByRole('button', { name: /run test/i });
    fireEvent.click(runButton);
    await waitFor(() => expect(screen.getByText('URL is required')).toBeInTheDocument());
    expect(mockCreateTest).not.toHaveBeenCalled();
  });

  it('calls createTest and navigates when form is valid', async () => {
    render(<Home />);
    const urlInput = screen.getByPlaceholderText('https://example.com');
    fireEvent.change(urlInput, { target: { value: 'https://api.test.com' } });
    fireEvent.click(screen.getByRole('button', { name: /run test/i }));
    await waitFor(() => expect(mockCreateTest).toHaveBeenCalledWith(
      expect.objectContaining({ targetUrl: 'https://api.test.com', type: 'backend' })
    ));
    expect(mockPush).toHaveBeenCalledWith('/results/new-test-id');
  });

  it('shows error message when createTest fails', async () => {
    mockCreateTest.mockRejectedValueOnce(new Error('network error'));
    render(<Home />);
    const urlInput = screen.getByPlaceholderText('https://example.com');
    fireEvent.change(urlInput, { target: { value: 'https://test.com' } });
    fireEvent.click(screen.getByRole('button', { name: /run test/i }));
    await waitFor(() => expect(screen.getByText('Failed to create test')).toBeInTheDocument());
  });

  it('shows backend, browser, and flow type buttons', () => {
    render(<Home />);
    expect(screen.getByRole('button', { name: /backend/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /browser/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /multi-step flow/i })).toBeInTheDocument();
  });

  it('shows load profile selector for backend type inside Advanced settings', () => {
    render(<Home />);
    const advancedBtn = screen.getAllByRole('button').find(b => b.textContent?.includes('Advanced settings'));
    expect(advancedBtn).toBeDefined();
    fireEvent.click(advancedBtn!);
    expect(screen.getByRole('button', { name: /spike/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /soak/i })).toBeInTheDocument();
  });
});

describe('Home page — template dropdown', () => {
  it('does not show template dropdown when no templates exist', async () => {
    render(<Home />);
    await waitFor(() => expect(mockGetTemplates).toHaveBeenCalled());
    // Template dropdown uses "Load from template…" as placeholder option
    expect(screen.queryByText('Load from template…')).not.toBeInTheDocument();
  });

  it('shows template dropdown when templates are available', async () => {
    mockGetTemplates.mockResolvedValueOnce({
      templates: [
        {
          id: 'tmpl-1', name: 'API Smoke', type: 'backend', target_url: 'http://api.com',
          description: null, options: { vus: 5, duration: '30s' }, thresholds: null,
          used_count: 2, created_at: new Date().toISOString(),
        },
      ],
    });
    render(<Home />);
    await waitFor(() => expect(screen.getByText('Load from template…')).toBeInTheDocument());
    expect(screen.getByText('API Smoke (backend)')).toBeInTheDocument();
  });

  it('populates form URL when a template is selected', async () => {
    mockGetTemplates.mockResolvedValueOnce({
      templates: [
        {
          id: 'tmpl-1', name: 'API Smoke', type: 'backend', target_url: 'http://template.com',
          description: null, options: { vus: 10, duration: '1m' }, thresholds: null,
          used_count: 0, created_at: new Date().toISOString(),
        },
      ],
    });
    render(<Home />);
    // Wait for the template dropdown to appear, then select by its default display value
    await waitFor(() => screen.getByDisplayValue('Load from template…'));
    fireEvent.change(screen.getByDisplayValue('Load from template…'), { target: { value: 'tmpl-1' } });
    expect((screen.getByPlaceholderText('https://example.com') as HTMLInputElement).value).toBe('http://template.com');
  });
});
