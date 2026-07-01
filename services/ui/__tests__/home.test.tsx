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
  previewThresholds: vi.fn().mockResolvedValue({ available: false }),
}));

import { createTest, getPresets, getResult, previewThresholds } from '@/lib/api';
const mockCreateTest = vi.mocked(createTest);
const mockGetPresets = vi.mocked(getPresets);
const mockGetResult = vi.mocked(getResult);
const mockPreviewThresholds = vi.mocked(previewThresholds);

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateTest.mockResolvedValue({ test: { id: 'new-test-id' } });
  mockGetPresets.mockResolvedValue({ presets: [] });
  mockGetResult.mockResolvedValue({ result: null } as never);
  mockPreviewThresholds.mockResolvedValue({ available: false });
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
    const urlInput = screen.getByPlaceholderText('api.acme.io/checkout');
    fireEvent.change(urlInput, { target: { value: 'https://api.test.com' } });
    fireEvent.click(screen.getByRole('button', { name: /run test/i }));
    await waitFor(() => expect(mockCreateTest).toHaveBeenCalledWith(
      expect.objectContaining({ targetUrl: 'https://api.test.com', type: 'backend' })
    ));
    expect(mockPush).toHaveBeenCalledWith('/results/new-test-id');
  });

  it('shows the server error message when createTest fails', async () => {
    mockCreateTest.mockRejectedValueOnce(new Error('Invalid targetUrl — must use http or https'));
    render(<Home />);
    const urlInput = screen.getByPlaceholderText('api.acme.io/checkout');
    fireEvent.change(urlInput, { target: { value: 'localhost:8081' } });
    fireEvent.click(screen.getByRole('button', { name: /run test/i }));
    await waitFor(() => expect(screen.getByText('Invalid targetUrl — must use http or https')).toBeInTheDocument());
  });

  it('falls back to a generic message when createTest rejects without an Error', async () => {
    mockCreateTest.mockRejectedValueOnce('not an Error instance');
    render(<Home />);
    const urlInput = screen.getByPlaceholderText('api.acme.io/checkout');
    fireEvent.change(urlInput, { target: { value: 'https://test.com' } });
    fireEvent.click(screen.getByRole('button', { name: /run test/i }));
    await waitFor(() => expect(screen.getByText('Failed to create test')).toBeInTheDocument());
  });

  it('shows backend, browser, and flow type buttons', () => {
    render(<Home />);
    expect(screen.getByRole('button', { name: /backend/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /browser/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^flow$/i })).toBeInTheDocument();
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

describe('Home page — script library template', () => {
  afterEach(() => stableSearchParams.delete('useScriptTemplate'));

  it('loads a built-in template into Custom Script mode when ?useScriptTemplate is set', async () => {
    stableSearchParams.set('useScriptTemplate', 'rest-api-load');
    render(<Home />);

    await waitFor(() => expect(screen.getByRole('button', { name: /custom script/i })).toHaveClass('bg-sel'));
    const textarea = await waitFor(() => screen.getByPlaceholderText(/import http from 'k6\/http'/i) as HTMLTextAreaElement);
    expect(textarea.value).toContain("import http from 'k6/http'");
    expect(textarea.value).toContain("const BASE_URL = 'https://example.com'");
  });

  it('ignores an unknown template id', async () => {
    stableSearchParams.set('useScriptTemplate', 'does-not-exist');
    render(<Home />);
    await waitFor(() => expect(mockGetPresets).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /ai generate/i })).toHaveClass('bg-sel');
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
    expect((screen.getByPlaceholderText('api.acme.io/checkout') as HTMLInputElement).value).toBe('preset.com');
  });
});

// Helper: fill the description textarea and blur it to trigger applyDescriptionParams
const blurDescription = (text: string) => {
  const ta = screen.getByPlaceholderText(/e\.g\. load test/i);
  fireEvent.change(ta, { target: { value: text } });
  fireEvent.blur(ta);
};

describe('Home page — applyDescriptionParams (description blur)', () => {
  it('extracts VU count and populates the Virtual users input', () => {
    render(<Home />);
    blurDescription('load test with 50 VUs for 2 minutes');
    // Advanced settings auto-opens (hiding the collapsed summary strip) to
    // reveal the parsed value in the "Virtual users" number input
    expect(screen.getByDisplayValue('50')).toBeInTheDocument();
  });

  it('extracts duration in minutes and selects it in the duration dropdown', () => {
    render(<Home />);
    blurDescription('run for 5 minutes');
    expect(screen.getByDisplayValue('5m')).toBeInTheDocument();
  });

  it('extracts duration in seconds and selects it in the duration dropdown', () => {
    render(<Home />);
    blurDescription('run for 30 seconds');
    expect(screen.getByDisplayValue('30s')).toBeInTheDocument();
  });

  it('extracts a trailing duration phrase with no "for"/"duration" anchor', () => {
    render(<Home />);
    blurDescription('load test 2 users 3 min');
    expect(screen.getByDisplayValue('3m')).toBeInTheDocument();
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
    // No numeric param detected → Advanced settings stays collapsed, and the
    // summary strip still shows the untouched default "5 VUs" (one of the two
    // "VUs" matches on the page — the other is the static "AI parses VUs…" hint)
    const matches = screen.getAllByText(/VUs/);
    expect(matches.some(el => /\b5\s*VUs\b/.test(el.textContent ?? ''))).toBe(true);
  });

  it('caps VU count at 100', () => {
    render(<Home />);
    blurDescription('load test with 500 VUs');
    // Advanced settings auto-opens; the capped value shows in the number input
    expect(screen.getByDisplayValue('100')).toBeInTheDocument();
  });

  it('extracts ramp-up duration', () => {
    render(<Home />);
    blurDescription('load test 10 VUs ramp up: 30s for 2 minutes');
    // Advanced settings auto-opens; "30s" lands in the Ramp-up text input
    // (duration "2m" is selected in the dropdown, so this match is unambiguous)
    expect(screen.getByDisplayValue('30s')).toBeInTheDocument();
  });

  // Keeps this regex's signal words in sync with the chat-parse prompt
  // (services/results-service/src/app.ts buildChatParsePrompt) — they were
  // found to disagree on "performance test" (backend) and "endpoint"/"page".
  it('detects "endpoint" as a backend signal', () => {
    render(<Home />);
    fireEvent.click(screen.getByRole('button', { name: /browser/i }));
    blurDescription('test this endpoint with 10 users');
    fireEvent.click(screen.getByRole('button', { name: /SLO thresholds/i }));
    // Browser-only thresholds disappear once the description flips type back to backend
    expect(screen.queryByText('INP ms max')).not.toBeInTheDocument();
  });

  it('detects "page" as a browser signal', () => {
    render(<Home />);
    blurDescription('test this page with 10 users');
    fireEvent.click(screen.getByRole('button', { name: /SLO thresholds/i }));
    expect(screen.getByText('INP ms max')).toBeInTheDocument();
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
    fireEvent.change(screen.getByPlaceholderText('api.acme.io/checkout'), { target: { value: 'https://browser.test.com' } });
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

describe('Home page — custom headers editor', () => {
  it('shows "No custom headers" message by default in Advanced settings', () => {
    render(<Home />);
    const advancedBtn = screen.getAllByRole('button').find(b => b.textContent?.includes('Advanced settings'));
    fireEvent.click(advancedBtn!);
    expect(screen.getByText(/no custom headers/i)).toBeInTheDocument();
  });

  it('adds a header row and includes it in the createTest payload', async () => {
    render(<Home />);
    fireEvent.change(screen.getByPlaceholderText('api.acme.io/checkout'), { target: { value: 'https://api.test.com' } });
    const advancedBtn = screen.getAllByRole('button').find(b => b.textContent?.includes('Advanced settings'));
    fireEvent.click(advancedBtn!);

    fireEvent.click(screen.getByRole('button', { name: /^\+ add$/i }));
    fireEvent.change(screen.getByPlaceholderText('Header-Name'), { target: { value: 'X-Api-Key' } });
    fireEvent.change(screen.getByPlaceholderText('value'), { target: { value: 'secret123' } });

    fireEvent.click(screen.getByRole('button', { name: /run test/i }));
    await waitFor(() => expect(mockCreateTest).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ headers: { 'X-Api-Key': 'secret123' } }),
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
      expect(screen.getByPlaceholderText('api.acme.io/checkout')).toHaveValue('rerun.example.com');
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

describe('Home page — threshold preview', () => {
  it('does not show the preview button until SLO thresholds are open', async () => {
    render(<Home />);
    fireEvent.change(screen.getByPlaceholderText('api.acme.io/checkout'), { target: { value: 'https://preview.test.com' } });
    expect(screen.queryByRole('button', { name: /preview against last run/i })).not.toBeInTheDocument();
  });

  it('calls previewThresholds and shows a passing result', async () => {
    mockPreviewThresholds.mockResolvedValueOnce({
      available: true,
      perfStatus: 'passed',
      thresholdViolations: [],
      basedOn: { testId: 't1', completedAt: '2026-01-01T00:00:00.000Z' },
    });
    render(<Home />);
    fireEvent.change(screen.getByPlaceholderText('api.acme.io/checkout'), { target: { value: 'https://preview.test.com' } });
    fireEvent.click(screen.getByRole('button', { name: /SLO thresholds/i }));

    const previewBtn = screen.getByRole('button', { name: /preview against last run/i });
    fireEvent.click(previewBtn);

    await waitFor(() => expect(mockPreviewThresholds).toHaveBeenCalledWith('https://preview.test.com', 'backend', expect.any(Object)));
    expect(await screen.findByText(/would pass/i)).toBeInTheDocument();
  });

  it('shows threshold violations when the preview fails', async () => {
    mockPreviewThresholds.mockResolvedValueOnce({
      available: true,
      perfStatus: 'failed',
      thresholdViolations: ['p95 response time 1200ms exceeds threshold 1000ms'],
      basedOn: { testId: 't1', completedAt: '2026-01-01T00:00:00.000Z' },
    });
    render(<Home />);
    fireEvent.change(screen.getByPlaceholderText('api.acme.io/checkout'), { target: { value: 'https://preview.test.com' } });
    fireEvent.click(screen.getByRole('button', { name: /SLO thresholds/i }));
    fireEvent.click(screen.getByRole('button', { name: /preview against last run/i }));

    expect(await screen.findByText(/would fail/i)).toBeInTheDocument();
    expect(screen.getByText(/p95 response time 1200ms exceeds threshold 1000ms/i)).toBeInTheDocument();
  });

  it('shows a message when no completed run is available', async () => {
    mockPreviewThresholds.mockResolvedValueOnce({ available: false });
    render(<Home />);
    fireEvent.change(screen.getByPlaceholderText('api.acme.io/checkout'), { target: { value: 'https://no-history.test.com' } });
    fireEvent.click(screen.getByRole('button', { name: /SLO thresholds/i }));
    fireEvent.click(screen.getByRole('button', { name: /preview against last run/i }));

    expect(await screen.findByText(/no completed run found/i)).toBeInTheDocument();
  });
});

describe('Home page — fromChat pre-fill (?fromChat=1 + chatFlowConfig)', () => {
  const FLOW_CONFIG = {
    steps: [
      { name: 'Register', url: 'http://localhost:8080/api/auth/register', method: 'POST' },
      { name: 'Login',    url: 'http://localhost:8080/api/auth/login',    method: 'POST' },
    ],
    targetUrl: 'http://localhost:8080',
    description: 'Register then login flow',
    options: { vus: 5, duration: '3m', profile: 'load' },
  };

  beforeEach(() => {
    stableSearchParams.set('fromChat', '1');
    sessionStorage.setItem('chatFlowConfig', JSON.stringify(FLOW_CONFIG));
  });

  afterEach(() => {
    stableSearchParams.delete('fromChat');
    sessionStorage.clear();
  });

  it('pre-fills the description field from chatFlowConfig', async () => {
    render(<Home />);
    await waitFor(() => {
      const descInput = screen.getByPlaceholderText(/e\.g\. load test/i) as HTMLInputElement;
      expect(descInput.value).toBe('Register then login flow');
    });
  });

  it('auto-opens Advanced settings when options include vus or duration', async () => {
    render(<Home />);
    // VU input should be visible without manually opening Advanced settings
    await waitFor(() => {
      expect(screen.getByDisplayValue('5')).toBeInTheDocument();
    });
  });

  it('removes chatFlowConfig from sessionStorage after reading', () => {
    render(<Home />);
    expect(sessionStorage.getItem('chatFlowConfig')).toBeNull();
  });

  it('falls back to normal form behavior when chatFlowConfig is absent', async () => {
    sessionStorage.clear(); // remove key the beforeEach set
    render(<Home />);
    // form should still be empty / default state — no pre-filled description
    const descInput = screen.getByPlaceholderText(/e\.g\. load test/i) as HTMLInputElement;
    expect(descInput.value).toBe('');
  });
});
