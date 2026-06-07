// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, cleanup } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
afterEach(() => cleanup());

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetSystemHealth = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  getSystemHealth: mockGetSystemHealth,
}));

import SystemHealth from '../app/components/SystemHealth';
import { HealthProvider } from '../lib/HealthContext';

const renderWithHealth = (ui: React.ReactElement) =>
  render(<HealthProvider>{ui}</HealthProvider>);

// ── Fixtures ──────────────────────────────────────────────────────────────────

const healthy = {
  healthy: true,
  services: [
    { name: 'api-service',     status: 'ok', checks: {} },
    { name: 'ai-service',      status: 'ok', checks: {} },
    { name: 'worker-backend',  status: 'ok', checks: {} },
    { name: 'worker-client',   status: 'ok', checks: {} },
    { name: 'results-service', status: 'ok', checks: {} },
  ],
};

const withDegraded = (name: string, status = 'degraded') => ({
  healthy: false,
  services: healthy.services.map(s => s.name === name ? { ...s, status } : s),
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSystemHealth.mockResolvedValue(healthy);
  localStorage.clear();
});

// ─── All healthy ──────────────────────────────────────────────────────────────

describe('SystemHealth — all healthy', () => {
  it('renders nothing when all services are ok', async () => {
    const { container } = render(<HealthProvider><SystemHealth /></HealthProvider>);
    await act(async () => {}); // flush effects + microtasks
    expect(container.firstChild).toBeNull();
  });
});

// ─── Degraded services ────────────────────────────────────────────────────────

describe('SystemHealth — degraded services', () => {
  it('shows warning banner for a degraded service', async () => {
    mockGetSystemHealth.mockResolvedValue(withDegraded('ai-service'));
    renderWithHealth(<SystemHealth />);
    // ai-service is mapped to "AI (Gemini)" via SERVICE_LABELS
    await waitFor(() => expect(screen.getByText(/AI.*Gemini/i)).toBeInTheDocument());
  });

  it('shows service-specific impact for ai-service', async () => {
    mockGetSystemHealth.mockResolvedValue(withDegraded('ai-service'));
    renderWithHealth(<SystemHealth />);
    await waitFor(() =>
      expect(screen.getByText(/New tests cannot be started/i)).toBeInTheDocument()
    );
  });

  it('shows impact for api-service degraded', async () => {
    mockGetSystemHealth.mockResolvedValue(withDegraded('api-service'));
    renderWithHealth(<SystemHealth />);
    await waitFor(() =>
      expect(screen.getByText(/Test creation unavailable/i)).toBeInTheDocument()
    );
  });

  it('shows impact for results-service degraded', async () => {
    mockGetSystemHealth.mockResolvedValue(withDegraded('results-service'));
    renderWithHealth(<SystemHealth />);
    await waitFor(() =>
      expect(screen.getByText(/Results unavailable/i)).toBeInTheDocument()
    );
  });

  it('shows capacity message when worker-backend is saturated', async () => {
    mockGetSystemHealth.mockResolvedValue(withDegraded('worker-backend', 'saturated'));
    renderWithHealth(<SystemHealth />);
    await waitFor(() =>
      expect(screen.getByText(/At capacity/i)).toBeInTheDocument()
    );
  });

  it('shows queueing message when worker-client is degraded (not saturated)', async () => {
    mockGetSystemHealth.mockResolvedValue(withDegraded('worker-client', 'degraded'));
    renderWithHealth(<SystemHealth />);
    await waitFor(() =>
      expect(screen.getByText(/Browser tests will queue/i)).toBeInTheDocument()
    );
  });

  it('shows unreachable status label', async () => {
    mockGetSystemHealth.mockResolvedValue(withDegraded('ai-service', 'unreachable'));
    renderWithHealth(<SystemHealth />);
    await waitFor(() =>
      expect(screen.getByText(/unreachable/i)).toBeInTheDocument()
    );
  });
});

// ─── Dismiss behaviour ────────────────────────────────────────────────────────

describe('SystemHealth — dismiss', () => {
  it('hides the banner after clicking dismiss', async () => {
    mockGetSystemHealth.mockResolvedValue(withDegraded('ai-service'));
    renderWithHealth(<SystemHealth />);
    // Wait for the impact message which is unique to this service
    await waitFor(() => screen.getByText(/New tests cannot be started/i));

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));

    await waitFor(() =>
      expect(screen.queryByText(/New tests cannot be started/i)).not.toBeInTheDocument()
    );
  });

  it('persists dismissal to localStorage after clicking dismiss', async () => {
    mockGetSystemHealth.mockResolvedValue(withDegraded('ai-service'));
    renderWithHealth(<SystemHealth />);
    await waitFor(() => screen.getByText(/New tests cannot be started/i));

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));

    await waitFor(() =>
      expect(screen.queryByText(/New tests cannot be started/i)).not.toBeInTheDocument()
    );
    expect(localStorage.getItem('systemHealthDismissed')).not.toBeNull();
  });
});

// ─── Polling ──────────────────────────────────────────────────────────────────

describe('SystemHealth — polling', () => {
  it('calls getSystemHealth on mount', async () => {
    renderWithHealth(<SystemHealth />);
    await act(async () => {});
    expect(mockGetSystemHealth).toHaveBeenCalledTimes(1);
  });

  it('polls again at 15-second interval', async () => {
    vi.useFakeTimers();
    try {
      renderWithHealth(<SystemHealth />);
      // Let initial fetch complete
      await act(async () => { await Promise.resolve(); });
      expect(mockGetSystemHealth).toHaveBeenCalledTimes(1);

      // Advance to next poll tick
      await act(async () => {
        vi.advanceTimersByTime(15_001);
        await Promise.resolve();
      });
      expect(mockGetSystemHealth).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('handles getSystemHealth network errors silently', async () => {
    mockGetSystemHealth.mockRejectedValue(new Error('network error'));
    const { container } = render(<HealthProvider><SystemHealth /></HealthProvider>);
    await act(async () => {});
    expect(container.firstChild).toBeNull(); // no crash, stays hidden
  });
});
