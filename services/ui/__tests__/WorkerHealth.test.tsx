// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, cleanup } from '@testing-library/react';
afterEach(() => cleanup());

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetSystemHealth = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  getSystemHealth: mockGetSystemHealth,
}));

import WorkerHealth from '../app/components/WorkerHealth';
import { HealthProvider } from '../lib/HealthContext';

const renderWithHealth = (ui: React.ReactElement) =>
  render(<HealthProvider>{ui}</HealthProvider>);

// ── Fixtures ──────────────────────────────────────────────────────────────────

const makeMetrics = (overrides: Partial<{
  cpuPercent: number; memoryMb: number; memoryPercent: number;
  activeTests: number; maxTests: number;
}> = {}) => ({
  cpuPercent:    overrides.cpuPercent    ?? 10,
  memoryMb:      overrides.memoryMb     ?? 256,
  memoryPercent: overrides.memoryPercent ?? 15,
  activeTests:   overrides.activeTests  ?? 0,
  maxTests:      overrides.maxTests     ?? 2,
});

const makeHealth = (services: Array<{ name: string; status: string; checks: object; metrics?: object }>) => ({
  healthy: services.every(s => s.status === 'ok'),
  services,
});

const noWorkers = makeHealth([{ name: 'api-service', status: 'ok', checks: {} }]);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSystemHealth.mockResolvedValue(noWorkers);
});

// ─── Hidden states ────────────────────────────────────────────────────────────

describe('WorkerHealth — hidden states', () => {
  it('renders nothing when no worker services have metrics', async () => {
    const { container } = render(<HealthProvider><WorkerHealth /></HealthProvider>);
    await act(async () => {});
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when worker present but without metrics', async () => {
    mockGetSystemHealth.mockResolvedValue(
      makeHealth([{ name: 'worker-backend', status: 'ok', checks: {} }]) // no metrics
    );
    const { container } = render(<HealthProvider><WorkerHealth /></HealthProvider>);
    await act(async () => {});
    expect(container.firstChild).toBeNull();
  });

  it('handles network errors silently', async () => {
    mockGetSystemHealth.mockRejectedValue(new Error('network'));
    const { container } = render(<HealthProvider><WorkerHealth /></HealthProvider>);
    await act(async () => {});
    expect(container.firstChild).toBeNull();
  });
});

// ─── Worker labels ────────────────────────────────────────────────────────────

describe('WorkerHealth — worker labels', () => {
  it('shows k6 label for worker-backend', async () => {
    mockGetSystemHealth.mockResolvedValue(
      makeHealth([{ name: 'worker-backend', status: 'ok', checks: {}, metrics: makeMetrics() }])
    );
    renderWithHealth(<WorkerHealth />);
    await waitFor(() => expect(screen.getByText(/k6/i)).toBeInTheDocument());
  });

  it('shows Browser label for worker-client', async () => {
    mockGetSystemHealth.mockResolvedValue(
      makeHealth([{ name: 'worker-client', status: 'ok', checks: {}, metrics: makeMetrics() }])
    );
    renderWithHealth(<WorkerHealth />);
    await waitFor(() => expect(screen.getByText(/browser/i)).toBeInTheDocument());
  });

  it('shows both workers when both have metrics', async () => {
    mockGetSystemHealth.mockResolvedValue(makeHealth([
      { name: 'worker-backend', status: 'ok', checks: {}, metrics: makeMetrics() },
      { name: 'worker-client',  status: 'ok', checks: {}, metrics: makeMetrics() },
    ]));
    renderWithHealth(<WorkerHealth />);
    await waitFor(() => {
      expect(screen.getByText(/k6/i)).toBeInTheDocument();
      expect(screen.getByText(/browser/i)).toBeInTheDocument();
    });
  });
});

// ─── Metrics display ──────────────────────────────────────────────────────────

describe('WorkerHealth — metrics display', () => {
  it('shows active/max test count', async () => {
    mockGetSystemHealth.mockResolvedValue(
      makeHealth([{ name: 'worker-backend', status: 'ok', checks: {}, metrics: makeMetrics({ activeTests: 1, maxTests: 2 }) }])
    );
    renderWithHealth(<WorkerHealth />);
    await waitFor(() => expect(screen.getByText(/1\/2/)).toBeInTheDocument());
  });

  it('shows memory percentage', async () => {
    mockGetSystemHealth.mockResolvedValue(
      makeHealth([{ name: 'worker-backend', status: 'ok', checks: {}, metrics: makeMetrics({ memoryPercent: 42 }) }])
    );
    renderWithHealth(<WorkerHealth />);
    // The component renders memoryPercent as a percentage label (e.g. "42 %")
    await waitFor(() => expect(screen.getByText(/42/)).toBeInTheDocument());
  });
});

// ─── Status states ────────────────────────────────────────────────────────────

describe('WorkerHealth — status states', () => {
  it('shows offline text when worker is unreachable', async () => {
    mockGetSystemHealth.mockResolvedValue(
      makeHealth([{ name: 'worker-backend', status: 'unreachable', checks: {}, metrics: makeMetrics() }])
    );
    renderWithHealth(<WorkerHealth />);
    await waitFor(() => expect(screen.getByText(/offline/i)).toBeInTheDocument());
  });

  it('does not render CPU/memory bars when offline', async () => {
    mockGetSystemHealth.mockResolvedValue(
      makeHealth([{ name: 'worker-backend', status: 'unreachable', checks: {}, metrics: makeMetrics({ cpuPercent: 80 }) }])
    );
    renderWithHealth(<WorkerHealth />);
    await waitFor(() => screen.getByText(/offline/i));
    expect(screen.queryByText(/mem/i)).not.toBeInTheDocument();
  });
});

// ─── Polling ──────────────────────────────────────────────────────────────────

describe('WorkerHealth — polling', () => {
  it('calls getSystemHealth on mount', async () => {
    renderWithHealth(<WorkerHealth />);
    await act(async () => {});
    expect(mockGetSystemHealth).toHaveBeenCalledTimes(1);
  });

  it('polls again at 15-second interval', async () => {
    vi.useFakeTimers();
    try {
      renderWithHealth(<WorkerHealth />);
      await act(async () => { await Promise.resolve(); });
      expect(mockGetSystemHealth).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(15_001);
        await Promise.resolve();
      });
      expect(mockGetSystemHealth).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('updates displayed metrics after each poll', async () => {
    mockGetSystemHealth
      .mockResolvedValueOnce(makeHealth([
        { name: 'worker-backend', status: 'ok', checks: {}, metrics: makeMetrics({ activeTests: 0, maxTests: 2 }) },
      ]))
      .mockResolvedValue(makeHealth([
        { name: 'worker-backend', status: 'ok', checks: {}, metrics: makeMetrics({ activeTests: 1, maxTests: 2 }) },
      ]));

    vi.useFakeTimers();
    try {
      renderWithHealth(<WorkerHealth />);
      // Flush initial fetch (no waitFor inside fake-timer scope — it uses setTimeout internally)
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByText(/0\/2/)).toBeInTheDocument();

      // Advance to next polling interval and flush the second fetch
      await act(async () => {
        vi.advanceTimersByTime(15_001);
        await Promise.resolve();
      });
      expect(screen.getByText(/1\/2/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
