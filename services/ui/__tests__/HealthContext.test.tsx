// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
afterEach(() => cleanup());

const mockGetSystemHealth = vi.hoisted(() => vi.fn());
const mockGetActiveTests  = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({
  getSystemHealth: mockGetSystemHealth,
  getActiveTests:  mockGetActiveTests,
}));

const mockUseResultsSocket = vi.hoisted(() => vi.fn());
vi.mock('@/lib/useResultsSocket', () => ({ useResultsSocket: mockUseResultsSocket }));

import { HealthProvider, useHealth } from '../lib/HealthContext';
import type { WSEvent } from '@/lib/useResultsSocket';

function Probe() {
  const { services, activeTests } = useHealth();
  return (
    <div>
      <span data-testid="services-count">{services.length}</span>
      <span data-testid="active-count">{activeTests.length}</span>
    </div>
  );
}

const activeTest = (testId: string) => ({
  test_id: testId, type: 'backend', target_url: 'http://a.com', status: 'running', created_at: new Date().toISOString(),
});

const emitLastEvent = (event: WSEvent) => {
  const onEvent = mockUseResultsSocket.mock.calls[mockUseResultsSocket.mock.calls.length - 1][0] as (e: WSEvent) => void;
  act(() => { onEvent(event); });
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSystemHealth.mockResolvedValue({ healthy: true, services: [] });
  mockGetActiveTests.mockResolvedValue({ active: [] });
});

describe('HealthContext — activeTests', () => {
  it('fetches active tests once on mount', async () => {
    mockGetActiveTests.mockResolvedValue({ active: [activeTest('t1')] });
    render(<HealthProvider><Probe /></HealthProvider>);
    await waitFor(() => expect(screen.getByTestId('active-count')).toHaveTextContent('1'));
  });

  it('silently ignores a fetch error and keeps an empty list', async () => {
    mockGetActiveTests.mockRejectedValue(new Error('network error'));
    render(<HealthProvider><Probe /></HealthProvider>);
    await waitFor(() => expect(mockGetActiveTests).toHaveBeenCalled());
    expect(screen.getByTestId('active-count')).toHaveTextContent('0');
  });

  it('re-fetches on a tests:changed WS event', async () => {
    render(<HealthProvider><Probe /></HealthProvider>);
    await waitFor(() => expect(mockGetActiveTests).toHaveBeenCalledTimes(1));

    mockGetActiveTests.mockResolvedValue({ active: [activeTest('t2')] });
    emitLastEvent({ type: 'tests:changed' });

    await waitFor(() => expect(screen.getByTestId('active-count')).toHaveTextContent('1'));
  });

  it('re-fetches on a reconnected event', async () => {
    render(<HealthProvider><Probe /></HealthProvider>);
    await waitFor(() => expect(mockGetActiveTests).toHaveBeenCalledTimes(1));

    emitLastEvent({ type: 'reconnected' });
    await waitFor(() => expect(mockGetActiveTests).toHaveBeenCalledTimes(2));
  });

  it('coalesces test:status + tests:changed fired together into a single debounced re-fetch', async () => {
    render(<HealthProvider><Probe /></HealthProvider>);
    await waitFor(() => expect(mockGetActiveTests).toHaveBeenCalledTimes(1));

    const onEvent = mockUseResultsSocket.mock.calls[mockUseResultsSocket.mock.calls.length - 1][0] as (e: WSEvent) => void;
    act(() => {
      onEvent({ type: 'test:status', testId: 't1', status: 'running' });
      onEvent({ type: 'tests:changed' });
    });

    await waitFor(() => expect(mockGetActiveTests).toHaveBeenCalledTimes(2));
    expect(mockGetActiveTests).toHaveBeenCalledTimes(2); // exactly one extra fetch, not two
  });

  it('ignores unrelated WS event types', async () => {
    render(<HealthProvider><Probe /></HealthProvider>);
    await waitFor(() => expect(mockGetActiveTests).toHaveBeenCalledTimes(1));

    emitLastEvent({ type: 'test:log', testId: 't1', level: 'info', line: 'hello' });
    await new Promise(r => setTimeout(r, 100));
    expect(mockGetActiveTests).toHaveBeenCalledTimes(1);
  });
});
