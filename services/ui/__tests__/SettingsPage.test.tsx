// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
afterEach(() => cleanup());

const mockUseAuth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/AuthContext', () => ({ useAuth: mockUseAuth }));

const mockGetLiveMetricWindow = vi.hoisted(() => vi.fn());
const mockSetLiveMetricWindow = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({
  getLiveMetricWindow: mockGetLiveMetricWindow,
  setLiveMetricWindow: mockSetLiveMetricWindow,
}));

import SettingsPage from '../app/settings/page';

const adminUser  = { id: 'u1', email: 'admin@example.com', role: 'admin', teams: [], currentTeamId: null, orgs: [] };
const memberUser = { id: 'u2', email: 'member@example.com', role: 'member', teams: [], currentTeamId: null, orgs: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetLiveMetricWindow.mockResolvedValue({ windowSec: 10 });
  mockSetLiveMetricWindow.mockResolvedValue({ windowSec: 10 });
});

describe('SettingsPage — non-admin', () => {
  it('shows an access-required message and never fetches the setting', async () => {
    mockUseAuth.mockReturnValue({ user: memberUser });
    render(<SettingsPage />);

    expect(screen.getByText(/Admin access required/i)).toBeInTheDocument();
    expect(mockGetLiveMetricWindow).not.toHaveBeenCalled();
  });

  it('shows the access-required message when there is no user at all', () => {
    mockUseAuth.mockReturnValue({ user: null });
    render(<SettingsPage />);

    expect(screen.getByText(/Admin access required/i)).toBeInTheDocument();
    expect(mockGetLiveMetricWindow).not.toHaveBeenCalled();
  });

  it('does not render the live-metrics-window panel at all', () => {
    mockUseAuth.mockReturnValue({ user: memberUser });
    render(<SettingsPage />);

    expect(screen.queryByText('Live metrics window')).not.toBeInTheDocument();
  });
});

describe('SettingsPage — admin, loading the current setting', () => {
  it('fetches the setting on mount', async () => {
    mockUseAuth.mockReturnValue({ user: adminUser });
    render(<SettingsPage />);

    await waitFor(() => expect(mockGetLiveMetricWindow).toHaveBeenCalledOnce());
  });

  it('shows a loading state before the fetch resolves', () => {
    mockGetLiveMetricWindow.mockReturnValue(new Promise(() => {}));
    mockUseAuth.mockReturnValue({ user: adminUser });
    render(<SettingsPage />);

    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('shows an error message when the fetch fails, instead of the options', async () => {
    mockGetLiveMetricWindow.mockRejectedValue(new Error('network error'));
    mockUseAuth.mockReturnValue({ user: adminUser });
    render(<SettingsPage />);

    await waitFor(() => expect(screen.getByText('Failed to load current setting')).toBeInTheDocument());
    expect(screen.queryByText('10s')).not.toBeInTheDocument();
  });

  it('renders all three window options once loaded', async () => {
    mockUseAuth.mockReturnValue({ user: adminUser });
    render(<SettingsPage />);

    await waitFor(() => expect(screen.getByText('10s')).toBeInTheDocument());
    expect(screen.getByText('30s')).toBeInTheDocument();
    expect(screen.getByText('1min')).toBeInTheDocument();
  });
});

describe('SettingsPage — admin, saving a change', () => {
  it('disables Save until a different option is selected', async () => {
    mockUseAuth.mockReturnValue({ user: adminUser });
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText('10s')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  it('enables Save once a different window option is clicked', async () => {
    mockUseAuth.mockReturnValue({ user: adminUser });
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText('10s')).toBeInTheDocument());

    fireEvent.click(screen.getByText('30s'));

    expect(screen.getByRole('button', { name: /^save$/i })).not.toBeDisabled();
  });

  it('calls setLiveMetricWindow with the newly selected value on Save', async () => {
    mockUseAuth.mockReturnValue({ user: adminUser });
    mockSetLiveMetricWindow.mockResolvedValue({ windowSec: 30 });
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText('10s')).toBeInTheDocument());

    fireEvent.click(screen.getByText('30s'));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockSetLiveMetricWindow).toHaveBeenCalledWith(30));
  });

  it('shows "Saved" and re-disables Save after a successful save', async () => {
    mockUseAuth.mockReturnValue({ user: adminUser });
    mockSetLiveMetricWindow.mockResolvedValue({ windowSec: 60 });
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText('10s')).toBeInTheDocument());

    fireEvent.click(screen.getByText('1min'));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  it('shows "Saving…" and disables the button while the request is in flight', async () => {
    mockUseAuth.mockReturnValue({ user: adminUser });
    let resolveSave!: (v: { windowSec: number }) => void;
    mockSetLiveMetricWindow.mockReturnValue(new Promise(resolve => { resolveSave = resolve; }));
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText('10s')).toBeInTheDocument());

    fireEvent.click(screen.getByText('30s'));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(screen.getByRole('button', { name: /saving/i })).toBeDisabled();
    resolveSave({ windowSec: 30 });
    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument());
  });

  it('shows the error message and does not show "Saved" when saving fails', async () => {
    mockUseAuth.mockReturnValue({ user: adminUser });
    mockSetLiveMetricWindow.mockRejectedValue(new Error('quota exceeded'));
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText('10s')).toBeInTheDocument());

    fireEvent.click(screen.getByText('30s'));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(screen.getByText('quota exceeded')).toBeInTheDocument());
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('falls back to a generic error message for a non-Error rejection', async () => {
    mockUseAuth.mockReturnValue({ user: adminUser });
    mockSetLiveMetricWindow.mockRejectedValue('some string rejection');
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText('10s')).toBeInTheDocument());

    fireEvent.click(screen.getByText('30s'));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(screen.getByText('Failed to save setting')).toBeInTheDocument());
  });

  it('clears a previous error once a save succeeds', async () => {
    mockUseAuth.mockReturnValue({ user: adminUser });
    mockSetLiveMetricWindow.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ windowSec: 30 });
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText('10s')).toBeInTheDocument());

    fireEvent.click(screen.getByText('30s'));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument());
    expect(screen.queryByText('boom')).not.toBeInTheDocument();
  });
});
