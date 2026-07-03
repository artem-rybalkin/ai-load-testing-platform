// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, cleanup, fireEvent } from '@testing-library/react';
afterEach(() => cleanup());

const mockGetAIStatus = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ getAIStatus: mockGetAIStatus }));

import AIStatus from '../app/components/AIStatus';

const STORAGE_KEY = 'aiStatusDismissedAt';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockGetAIStatus.mockResolvedValue({ quotaExceeded: false });
});

// ─── Hidden state ─────────────────────────────────────────────────────────────

describe('AIStatus — hidden state', () => {
  it('renders nothing when quota is not exceeded', async () => {
    const { container } = render(<AIStatus />);
    await act(async () => {});
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing while the status check is still pending', () => {
    mockGetAIStatus.mockReturnValue(new Promise(() => {})); // never resolves
    const { container } = render(<AIStatus />);
    expect(container.firstChild).toBeNull();
  });

  it('handles a rejected status check silently (no banner, no throw)', async () => {
    mockGetAIStatus.mockRejectedValue(new Error('network error'));
    const { container } = render(<AIStatus />);
    await act(async () => {});
    expect(container.firstChild).toBeNull();
  });
});

// ─── Quota-exceeded banner ────────────────────────────────────────────────────

describe('AIStatus — quota-exceeded banner', () => {
  it('shows the banner when quotaExceeded is true', async () => {
    mockGetAIStatus.mockResolvedValue({ quotaExceeded: true, since: new Date().toISOString() });
    render(<AIStatus />);
    await waitFor(() => expect(screen.getByText(/daily quota exceeded/i)).toBeInTheDocument());
  });

  it('mentions that cached-script tests still work', async () => {
    mockGetAIStatus.mockResolvedValue({ quotaExceeded: true, since: new Date().toISOString() });
    render(<AIStatus />);
    await waitFor(() => expect(screen.getByText(/cached scripts continue to work/i)).toBeInTheDocument());
  });

  it('does not re-show the banner if the quota was exceeded before the last dismissal', async () => {
    const dismissedAt = Date.now();
    localStorage.setItem(STORAGE_KEY, String(dismissedAt));
    mockGetAIStatus.mockResolvedValue({ quotaExceeded: true, since: new Date(dismissedAt - 60_000).toISOString() });

    const { container } = render(<AIStatus />);
    await act(async () => {});
    expect(container.firstChild).toBeNull();
  });

  it('re-shows the banner when quota was exceeded again after the last dismissal', async () => {
    const dismissedAt = Date.now() - 120_000;
    localStorage.setItem(STORAGE_KEY, String(dismissedAt));
    mockGetAIStatus.mockResolvedValue({ quotaExceeded: true, since: new Date().toISOString() });

    render(<AIStatus />);
    await waitFor(() => expect(screen.getByText(/daily quota exceeded/i)).toBeInTheDocument());
  });

  it('treats a missing `since` field as "now" (still shows the banner when never dismissed)', async () => {
    mockGetAIStatus.mockResolvedValue({ quotaExceeded: true });
    render(<AIStatus />);
    await waitFor(() => expect(screen.getByText(/daily quota exceeded/i)).toBeInTheDocument());
  });
});

// ─── Dismiss button ───────────────────────────────────────────────────────────

describe('AIStatus — dismiss button', () => {
  it('hides the banner and persists the dismissal timestamp when clicked', async () => {
    mockGetAIStatus.mockResolvedValue({ quotaExceeded: true, since: new Date().toISOString() });
    render(<AIStatus />);
    await waitFor(() => expect(screen.getByText(/daily quota exceeded/i)).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Dismiss'));

    expect(screen.queryByText(/daily quota exceeded/i)).not.toBeInTheDocument();
    expect(Number(localStorage.getItem(STORAGE_KEY))).toBeGreaterThan(0);
  });
});

// ─── Polling ──────────────────────────────────────────────────────────────────

describe('AIStatus — polling', () => {
  it('calls getAIStatus once on mount', async () => {
    render(<AIStatus />);
    await act(async () => {});
    expect(mockGetAIStatus).toHaveBeenCalledTimes(1);
  });

  it('polls again at the 60-second interval', async () => {
    vi.useFakeTimers();
    try {
      render(<AIStatus />);
      await act(async () => { await Promise.resolve(); });
      expect(mockGetAIStatus).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(60_001);
        await Promise.resolve();
      });
      expect(mockGetAIStatus).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the polling interval on unmount', async () => {
    vi.useFakeTimers();
    try {
      const { unmount } = render(<AIStatus />);
      await act(async () => { await Promise.resolve(); });
      unmount();

      await act(async () => {
        vi.advanceTimersByTime(120_000);
        await Promise.resolve();
      });
      expect(mockGetAIStatus).toHaveBeenCalledTimes(1); // only the initial mount call
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-hides the banner on a later poll once quota is no longer exceeded', async () => {
    mockGetAIStatus
      .mockResolvedValueOnce({ quotaExceeded: true, since: new Date().toISOString() })
      .mockResolvedValue({ quotaExceeded: false });

    vi.useFakeTimers();
    try {
      render(<AIStatus />);
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByText(/daily quota exceeded/i)).toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(60_001);
        await Promise.resolve();
      });
      expect(screen.queryByText(/daily quota exceeded/i)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
