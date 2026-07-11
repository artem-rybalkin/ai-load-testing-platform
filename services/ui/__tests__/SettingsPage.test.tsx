// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { createRoutesStub } from 'react-router';
afterEach(() => cleanup());

const mockUseAuth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/AuthContext', () => ({ useAuth: mockUseAuth }));

const mockGetMe = vi.hoisted(() => vi.fn());
const mockGetLiveMetricWindow = vi.hoisted(() => vi.fn());
const mockSetLiveMetricWindow = vi.hoisted(() => vi.fn());
const mockGetAiProvider = vi.hoisted(() => vi.fn());
const mockSetAiProvider = vi.hoisted(() => vi.fn());
const mockGetOperationalSettings = vi.hoisted(() => vi.fn());
const mockSetOperationalSettings = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({
  getMe: mockGetMe,
  getLiveMetricWindow: mockGetLiveMetricWindow,
  setLiveMetricWindow: mockSetLiveMetricWindow,
  getAiProvider: mockGetAiProvider,
  setAiProvider: mockSetAiProvider,
  getOperationalSettings: mockGetOperationalSettings,
  setOperationalSettings: mockSetOperationalSettings,
}));

import SettingsPage, { loader } from '../app/settings/page';

// SettingsPage now fetches its data via a route loader instead of a mount-time
// useEffect — render it through a routes stub so useLoaderData() has the
// router context it needs.
function renderSettingsPage() {
  const Stub = createRoutesStub([{ path: '/settings', Component: SettingsPage, loader, HydrateFallback: () => null }]);
  return render(<Stub initialEntries={['/settings']} />);
}

const adminUser  = { id: 'u1', email: 'admin@example.com', role: 'admin', teams: [], currentTeamId: null, orgs: [] };
const memberUser = { id: 'u2', email: 'member@example.com', role: 'member', teams: [], currentTeamId: null, orgs: [] };

// Sets both the component's own useAuth() (role-gating render logic) and the
// loader's getMe() (data fetching) to the same user — they're two independent
// calls post-migration, but tests need them consistent.
function setUser(user: typeof adminUser | typeof memberUser) {
  mockUseAuth.mockReturnValue({ user });
  mockGetMe.mockResolvedValue(user);
}

const defaultAiProvider = {
  provider: 'gemini' as const,
  fallbacks: [] as string[],
  available: { gemini: true, openai: false, anthropic: false },
};

const defaultOperationalSettings = {
  staleRunningMinutes: 15,
  stalePendingMinutes: 30,
  liveMetricsRetentionDays: 30,
  testResultsRetentionDays: 0,
  auditLogRetentionDays: 180,
  rateLimitMax: 600,
  aiRateLimitMax: 20,
  capacityAbortP95Ms: 2000,
  capacityAbortErrorRatePct: 5,
  capacityAbortDelaySec: 10,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetLiveMetricWindow.mockResolvedValue({ windowSec: 10 });
  mockSetLiveMetricWindow.mockResolvedValue({ windowSec: 10 });
  mockGetAiProvider.mockResolvedValue(defaultAiProvider);
  mockSetAiProvider.mockResolvedValue({ provider: 'gemini', fallbacks: [] });
  mockGetOperationalSettings.mockResolvedValue(defaultOperationalSettings);
  mockSetOperationalSettings.mockResolvedValue(defaultOperationalSettings);
});

describe('SettingsPage — non-admin', () => {
  it('shows an access-required message and never fetches the setting', async () => {
    setUser(memberUser);
    renderSettingsPage();

    expect(await screen.findByText(/Admin access required/i)).toBeInTheDocument();
    expect(mockGetLiveMetricWindow).not.toHaveBeenCalled();
    expect(mockGetAiProvider).not.toHaveBeenCalled();
    expect(mockGetOperationalSettings).not.toHaveBeenCalled();
  });

  it('does not render the live-metrics-window panel at all', async () => {
    setUser(memberUser);
    renderSettingsPage();

    expect(await screen.findByText(/Admin access required/i)).toBeInTheDocument();
    expect(screen.queryByText('Live metrics window')).not.toBeInTheDocument();
    expect(screen.queryByText('Platform-default AI provider')).not.toBeInTheDocument();
    expect(screen.queryByText('Retention & rate limits')).not.toBeInTheDocument();
  });
});

describe('SettingsPage — admin, loading the current setting', () => {
  it('fetches the setting on mount', async () => {
    setUser(adminUser);
    renderSettingsPage();

    await waitFor(() => expect(mockGetLiveMetricWindow).toHaveBeenCalledOnce());
  });

  it('shows an error message when the fetch fails, instead of the options', async () => {
    mockGetLiveMetricWindow.mockRejectedValue(new Error('network error'));
    setUser(adminUser);
    renderSettingsPage();

    await waitFor(() => expect(screen.getByText('Failed to load current setting')).toBeInTheDocument());
    expect(screen.queryByText('10s')).not.toBeInTheDocument();
  });

  it('renders all three window options once loaded', async () => {
    setUser(adminUser);
    renderSettingsPage();

    expect(await screen.findByText('10s')).toBeInTheDocument();
    expect(screen.getByText('30s')).toBeInTheDocument();
    expect(screen.getByText('1min')).toBeInTheDocument();
  });
});

describe('SettingsPage — admin, saving a change', () => {
  it('disables Save until a different option is selected', async () => {
    setUser(adminUser);
    renderSettingsPage();
    await screen.findByText('10s');

    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  it('enables Save once a different window option is clicked', async () => {
    setUser(adminUser);
    renderSettingsPage();
    await screen.findByText('10s');

    fireEvent.click(screen.getByText('30s'));

    expect(screen.getByRole('button', { name: /^save$/i })).not.toBeDisabled();
  });

  it('calls setLiveMetricWindow with the newly selected value on Save', async () => {
    setUser(adminUser);
    mockSetLiveMetricWindow.mockResolvedValue({ windowSec: 30 });
    renderSettingsPage();
    await screen.findByText('10s');

    fireEvent.click(screen.getByText('30s'));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockSetLiveMetricWindow).toHaveBeenCalledWith(30));
  });

  it('shows "Saved" and re-disables Save after a successful save', async () => {
    setUser(adminUser);
    mockSetLiveMetricWindow.mockResolvedValue({ windowSec: 60 });
    renderSettingsPage();
    await screen.findByText('10s');

    fireEvent.click(screen.getByText('1min'));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  it('shows "Saving…" and disables the button while the request is in flight', async () => {
    setUser(adminUser);
    let resolveSave!: (v: { windowSec: number }) => void;
    mockSetLiveMetricWindow.mockReturnValue(new Promise(resolve => { resolveSave = resolve; }));
    renderSettingsPage();
    await screen.findByText('10s');

    fireEvent.click(screen.getByText('30s'));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(screen.getByRole('button', { name: /saving/i })).toBeDisabled();
    resolveSave({ windowSec: 30 });
    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument());
  });

  it('shows the error message and does not show "Saved" when saving fails', async () => {
    setUser(adminUser);
    mockSetLiveMetricWindow.mockRejectedValue(new Error('quota exceeded'));
    renderSettingsPage();
    await screen.findByText('10s');

    fireEvent.click(screen.getByText('30s'));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(screen.getByText('quota exceeded')).toBeInTheDocument());
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('falls back to a generic error message for a non-Error rejection', async () => {
    setUser(adminUser);
    mockSetLiveMetricWindow.mockRejectedValue('some string rejection');
    renderSettingsPage();
    await screen.findByText('10s');

    fireEvent.click(screen.getByText('30s'));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(screen.getByText('Failed to save setting')).toBeInTheDocument());
  });

  it('clears a previous error once a save succeeds', async () => {
    setUser(adminUser);
    mockSetLiveMetricWindow.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ windowSec: 30 });
    renderSettingsPage();
    await screen.findByText('10s');

    fireEvent.click(screen.getByText('30s'));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument());
    expect(screen.queryByText('boom')).not.toBeInTheDocument();
  });
});

describe('SettingsPage — platform-default AI provider', () => {
  it('fetches the current AI provider setting on mount', async () => {
    setUser(adminUser);
    renderSettingsPage();

    await waitFor(() => expect(mockGetAiProvider).toHaveBeenCalledOnce());
    expect(await screen.findByText('Platform-default AI provider')).toBeInTheDocument();
  });

  it('shows an error message when the fetch fails, instead of the picker', async () => {
    mockGetAiProvider.mockRejectedValue(new Error('network error'));
    setUser(adminUser);
    renderSettingsPage();

    await waitFor(() => expect(screen.getByText('Failed to load AI provider setting')).toBeInTheDocument());
    expect(screen.queryByText('Primary provider')).not.toBeInTheDocument();
  });

  it('renders the configured primary provider and marks unconfigured providers', async () => {
    setUser(adminUser);
    renderSettingsPage();

    expect(await screen.findByText('Primary provider')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Gemini' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'OpenAI (not configured)' })).toBeInTheDocument();
  });

  it('calls setAiProvider with the selected primary provider and fallbacks on save', async () => {
    setUser(adminUser);
    mockSetAiProvider.mockResolvedValue({ provider: 'openai', fallbacks: ['gemini'] });
    renderSettingsPage();
    await screen.findByText('Primary provider');

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'openai' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /gemini/i }));
    fireEvent.click(screen.getByRole('button', { name: /save provider/i }));

    await waitFor(() => expect(mockSetAiProvider).toHaveBeenCalledWith('openai', ['gemini']));
  });

  it('shows "Saved" after a successful save', async () => {
    setUser(adminUser);
    renderSettingsPage();
    await screen.findByText('Primary provider');

    fireEvent.click(screen.getByRole('button', { name: /save provider/i }));

    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument());
  });

  it('shows the error message and does not show "Saved" when saving fails', async () => {
    setUser(adminUser);
    mockSetAiProvider.mockRejectedValue(new Error('save failed'));
    renderSettingsPage();
    await screen.findByText('Primary provider');

    fireEvent.click(screen.getByRole('button', { name: /save provider/i }));

    await waitFor(() => expect(screen.getByText('save failed')).toBeInTheDocument());
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('does not offer the primary provider as one of its own fallback options', async () => {
    setUser(adminUser);
    renderSettingsPage();
    await screen.findByText('Primary provider');

    // Default primary is 'gemini' — its own checkbox should not appear under Fallback order.
    expect(screen.queryByRole('checkbox', { name: /^gemini/i })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /openai/i })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /claude/i })).toBeInTheDocument();
  });
});

describe('SettingsPage — retention & rate limits', () => {
  it('fetches the current operational settings on mount and renders all 10 fields', async () => {
    setUser(adminUser);
    renderSettingsPage();

    await waitFor(() => expect(mockGetOperationalSettings).toHaveBeenCalledOnce());
    expect(await screen.findByText('Retention & rate limits')).toBeInTheDocument();
    expect(screen.getByText('Stale "running" timeout')).toBeInTheDocument();
    expect(screen.getByText('Global rate limit')).toBeInTheDocument();
    expect(screen.getByText('AI rate limit')).toBeInTheDocument();
    expect(screen.getByText('Capacity-test abort p95 (ms)')).toBeInTheDocument();
    expect(screen.getByText('Capacity-test abort error rate (%)')).toBeInTheDocument();
    expect(screen.getByText('Capacity-test abort grace period (s)')).toBeInTheDocument();
  });

  it('shows an error message when the fetch fails, instead of the fields', async () => {
    mockGetOperationalSettings.mockRejectedValue(new Error('network error'));
    setUser(adminUser);
    renderSettingsPage();

    await waitFor(() => expect(screen.getByText('Failed to load operational settings')).toBeInTheDocument());
    expect(screen.queryByText('Global rate limit')).not.toBeInTheDocument();
  });

  it('disables Save settings until a field is changed', async () => {
    setUser(adminUser);
    renderSettingsPage();
    await screen.findByText('Retention & rate limits');

    expect(screen.getByRole('button', { name: /save settings/i })).toBeDisabled();
  });

  it('calls setOperationalSettings with the full edited draft on Save settings', async () => {
    setUser(adminUser);
    mockSetOperationalSettings.mockResolvedValue({ ...defaultOperationalSettings, rateLimitMax: 1000 });
    renderSettingsPage();
    await screen.findByText('Retention & rate limits');

    const rateInput = screen.getByDisplayValue('600');
    fireEvent.change(rateInput, { target: { value: '1000' } });
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() => expect(mockSetOperationalSettings).toHaveBeenCalledWith({ ...defaultOperationalSettings, rateLimitMax: 1000 }));
  });

  it('edits the capacity-abort p95 threshold and saves it alongside the rest of the draft', async () => {
    setUser(adminUser);
    mockSetOperationalSettings.mockResolvedValue({ ...defaultOperationalSettings, capacityAbortP95Ms: 3000 });
    renderSettingsPage();
    await screen.findByText('Retention & rate limits');

    const p95Input = screen.getByDisplayValue('2000');
    fireEvent.change(p95Input, { target: { value: '3000' } });
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() => expect(mockSetOperationalSettings).toHaveBeenCalledWith({ ...defaultOperationalSettings, capacityAbortP95Ms: 3000 }));
  });

  it('shows "Saved" after a successful save', async () => {
    setUser(adminUser);
    renderSettingsPage();
    await screen.findByText('Retention & rate limits');

    const rateInput = screen.getByDisplayValue('600');
    fireEvent.change(rateInput, { target: { value: '1000' } });
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() => expect(screen.getAllByText('Saved').length).toBeGreaterThan(0));
  });

  it('shows the error message when saving fails', async () => {
    setUser(adminUser);
    mockSetOperationalSettings.mockRejectedValue(new Error('invalid value'));
    renderSettingsPage();
    await screen.findByText('Retention & rate limits');

    const rateInput = screen.getByDisplayValue('600');
    fireEvent.change(rateInput, { target: { value: '1000' } });
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() => expect(screen.getByText('invalid value')).toBeInTheDocument());
  });
});
