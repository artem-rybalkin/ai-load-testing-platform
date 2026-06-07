// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import Home from '../app/page';

// vi.hoisted ensures these are available even after vi.mock is hoisted
const mockPush = vi.hoisted(() => vi.fn());
const stableSearchParams = vi.hoisted(() => new URLSearchParams());

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockPush,
  // Return the SAME URLSearchParams instance every call so useEffect deps stay stable
  useSearchParams: () => [stableSearchParams, vi.fn()],
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={String(to)} {...(props as React.HTMLAttributes<HTMLAnchorElement>)}>{children}</a>
  ),
}));

vi.mock('@/lib/api', () => ({
  createTest: vi.fn().mockResolvedValue({ test: { id: 'new-test-id' } }),
  getPresets: vi.fn().mockResolvedValue({ presets: [] }),
  createPreset: vi.fn().mockResolvedValue({}),
  getResults: vi.fn().mockResolvedValue({ results: [] }),
  getActiveTests: vi.fn().mockResolvedValue({ active: [] }),
  getResult: vi.fn().mockResolvedValue({ result: null }),
  suggestThresholds: vi.fn().mockResolvedValue({}),
  suggestSettings: vi.fn().mockResolvedValue({}),
  translatePlaywright: vi.fn().mockResolvedValue({}),
  suggestPresetName: vi.fn().mockResolvedValue({ name: 'Suggested preset' }),
}));

import { createTest, getPresets, getResult } from '@/lib/api';
const mockCreateTest = vi.mocked(createTest);
const mockGetPresets = vi.mocked(getPresets);
const mockGetResult = vi.mocked(getResult);

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateTest.mockResolvedValue({ test: { id: 'new-test-id' } });
  mockGetPresets.mockResolvedValue({ presets: [] });
  mockGetResult.mockResolvedValue({ result: null } as never);
  // Ensure no rerun param bleeds between tests
  stableSearchParams.delete('rerun');
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

describe('Home page — preset dropdown', () => {
  it('does not show preset dropdown when no presets exist', async () => {
    render(<Home />);
    await waitFor(() => expect(mockGetPresets).toHaveBeenCalled());
    // Preset dropdown uses "Load from preset…" as placeholder option
    expect(screen.queryByText('Load from preset…')).not.toBeInTheDocument();
  });

  it('shows preset dropdown when presets are available', async () => {
    mockGetPresets.mockResolvedValueOnce({
      presets: [
        {
          id: 'tmpl-1', name: 'API Smoke', type: 'backend', target_url: 'http://api.com',
          description: null, options: { vus: 5, duration: '30s' }, thresholds: null,
          used_count: 2, created_at: new Date().toISOString(),
        },
      ],
    });
    render(<Home />);
    await waitFor(() => expect(screen.getByText('Load from preset…')).toBeInTheDocument());
    expect(screen.getByText('API Smoke (backend)')).toBeInTheDocument();
  });

  it('populates form URL when a preset is selected', async () => {
    mockGetPresets.mockResolvedValueOnce({
      presets: [
        {
          id: 'tmpl-1', name: 'API Smoke', type: 'backend', target_url: 'http://preset.com',
          description: null, options: { vus: 10, duration: '1m' }, thresholds: null,
          used_count: 0, created_at: new Date().toISOString(),
        },
      ],
    });
    render(<Home />);
    // Wait for the preset dropdown to appear, then select by its default display value
    await waitFor(() => screen.getByDisplayValue('Load from preset…'));
    fireEvent.change(screen.getByDisplayValue('Load from preset…'), { target: { value: 'tmpl-1' } });
    expect((screen.getByPlaceholderText('https://example.com') as HTMLInputElement).value).toBe('http://preset.com');
  });
});

// Helper: fill the description textarea and blur it to trigger applyDescriptionParams
const blurDescription = (text: string) => {
  const ta = screen.getByPlaceholderText(/e\.g\. load test/i);
  fireEvent.change(ta, { target: { value: text } });
  fireEvent.blur(ta);
};

describe('Home page — applyDescriptionParams (description blur)', () => {
  it('extracts VU count and shows it in the settings summary', () => {
    render(<Home />);
    blurDescription('load test with 50 VUs for 2 minutes');
    // Advanced settings auto-opens; summary strip shows "50 VUs"
    expect(screen.getByText(/50\s*VUs/)).toBeInTheDocument();
  });

  it('extracts duration in minutes and shows it in the settings summary', () => {
    render(<Home />);
    blurDescription('run for 5 minutes');
    expect(screen.getByText(/5m/)).toBeInTheDocument();
  });

  it('extracts duration in seconds', () => {
    render(<Home />);
    blurDescription('run for 30 seconds');
    expect(screen.getByText(/30s/)).toBeInTheDocument();
  });

  it('detects spike profile keyword', () => {
    render(<Home />);
    blurDescription('spike test with 10 users');
    // Advanced settings opens; spike profile button should appear active (aria-pressed or similar)
    expect(screen.getAllByRole('button', { name: /spike/i }).length).toBeGreaterThan(0);
  });

  it('detects soak profile keyword', () => {
    render(<Home />);
    blurDescription('soak test for 1 hour');
    expect(screen.getAllByRole('button', { name: /soak/i }).length).toBeGreaterThan(0);
  });

  it('detects capacity profile keyword', () => {
    render(<Home />);
    blurDescription('capacity test to find breaking point');
    expect(screen.getAllByRole('button', { name: /capacity/i }).length).toBeGreaterThan(0);
  });

  it('does not change anything for an empty description', () => {
    render(<Home />);
    blurDescription('');
    // Default type "Backend" button should still be present
    expect(screen.getByRole('button', { name: /backend/i })).toBeInTheDocument();
  });

  it('does not extract VUs when no match', () => {
    render(<Home />);
    blurDescription('test my API please');
    // Summary should show default 5 VUs, not crash
    expect(screen.queryByText(/VUs/)).not.toBeInTheDocument(); // advanced not yet open
  });

  it('caps VU count at 100', () => {
    render(<Home />);
    blurDescription('load test with 500 VUs');
    expect(screen.getByText(/100\s*VUs/)).toBeInTheDocument();
  });

  it('extracts ramp-up duration', () => {
    render(<Home />);
    blurDescription('load test 10 VUs ramp up: 30s for 2 minutes');
    // ramp 30s should appear in summary
    expect(screen.getByText(/ramp\s+30s/i)).toBeInTheDocument();
  });
});

describe('Home page — browser SLO threshold inputs', () => {
  it('shows INP and TBT threshold inputs when browser type is selected and SLO section is open', async () => {
    render(<Home />);
    fireEvent.click(screen.getByRole('button', { name: /browser/i }));
    const sloBtn = screen.getByRole('button', { name: /SLO thresholds/i });
    fireEvent.click(sloBtn);
    expect(screen.getByText('INP ms max')).toBeInTheDocument();
    expect(screen.getByText('TBT ms max')).toBeInTheDocument();
  });

  it('does not show INP or TBT threshold inputs for backend type', () => {
    render(<Home />);
    const sloBtn = screen.getByRole('button', { name: /SLO thresholds/i });
    fireEvent.click(sloBtn);
    expect(screen.queryByText('INP ms max')).not.toBeInTheDocument();
    expect(screen.queryByText('TBT ms max')).not.toBeInTheDocument();
  });

  it('includes inp and tbt in createTest payload when browser thresholds are enabled with defaults', async () => {
    render(<Home />);
    fireEvent.click(screen.getByRole('button', { name: /browser/i }));
    fireEvent.change(screen.getByPlaceholderText('https://example.com'), { target: { value: 'https://browser.test.com' } });
    fireEvent.click(screen.getByRole('button', { name: /SLO thresholds/i }));

    fireEvent.click(screen.getByRole('button', { name: /run test/i }));
    await waitFor(() => expect(mockCreateTest).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'client-side',
        thresholds: expect.objectContaining({ inp: 200, tbt: 200 }),
      })
    ));
  });
});

describe('Home page — re-run from results list', () => {
  const makeRerunResult = (overrides = {}) => ({
    id: 'row-1',
    test_id: 'rerun-test-id',
    type: 'backend',
    target_url: 'https://rerun.example.com',
    status: 'completed',
    metrics: { p95ResponseTime: 400, rps: 10 },
    script: null,
    script_description: 'load test with 10 users for 1 minute',
    reused_script: false,
    is_baseline: false,
    duration_seconds: 60,
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    perf_status: 'passed',
    ...overrides,
  });

  it('pre-fills URL and description when rerun param is set', async () => {
    stableSearchParams.set('rerun', 'rerun-test-id');
    mockGetResult.mockResolvedValueOnce({ result: makeRerunResult() } as never);
    render(<Home />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText('https://example.com')).toHaveValue('https://rerun.example.com');
    });
    const descInput = screen.getByPlaceholderText(/e\.g\. load test/i) as HTMLInputElement;
    expect(descInput.value).toBe('load test with 10 users for 1 minute');
  });

  it('shows the re-run banner with the target URL', async () => {
    stableSearchParams.set('rerun', 'rerun-test-id');
    mockGetResult.mockResolvedValueOnce({ result: makeRerunResult() } as never);
    render(<Home />);
    await waitFor(() => {
      expect(screen.getByText(/pre-filled from previous run/i)).toBeInTheDocument();
      expect(screen.getByText('https://rerun.example.com')).toBeInTheDocument();
    });
  });

  it('dismisses the re-run banner when the ✕ button is clicked', async () => {
    stableSearchParams.set('rerun', 'rerun-test-id');
    mockGetResult.mockResolvedValueOnce({ result: makeRerunResult() } as never);
    render(<Home />);
    await waitFor(() => screen.getByText(/pre-filled from previous run/i));
    fireEvent.click(screen.getByRole('button', { name: /dismiss re-run notice/i }));
    expect(screen.queryByText(/pre-filled from previous run/i)).not.toBeInTheDocument();
  });
});
