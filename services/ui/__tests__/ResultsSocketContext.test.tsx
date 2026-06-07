// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import { useContext } from 'react';
import { ResultsSocketContext, ResultsSocketProvider, useSocketContext } from '../lib/ResultsSocketContext';
afterEach(() => cleanup());

// ── WebSocket mock ────────────────────────────────────────────────────────────

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0; // CONNECTING
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  close() {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }

  static reset() { MockWebSocket.instances = []; }
  static latest() { return MockWebSocket.instances[MockWebSocket.instances.length - 1]; }
}

beforeEach(() => {
  MockWebSocket.reset();
  vi.stubGlobal('WebSocket', MockWebSocket);
});
afterEach(() => { vi.unstubAllGlobals(); });

// ── Helper component ──────────────────────────────────────────────────────────

function Receiver({ onEvent }: { onEvent: (e: unknown) => void }) {
  const ctx = useSocketContext();
  if (ctx) {
    ctx.subscribe(onEvent);
  }
  return <div data-testid="receiver">ok</div>;
}

// ─── Provider renders children ────────────────────────────────────────────────

describe('ResultsSocketProvider', () => {
  it('renders children', () => {
    render(
      <ResultsSocketProvider>
        <div data-testid="child">hello</div>
      </ResultsSocketProvider>
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('creates a WebSocket connection on mount', () => {
    render(<ResultsSocketProvider><div /></ResultsSocketProvider>);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.latest().url).toMatch(/ws:\/\/localhost:3004\/ws/);
  });

  it('closes the WebSocket and nulls onclose on unmount (no reconnect after intentional close)', () => {
    const { unmount } = render(<ResultsSocketProvider><div /></ResultsSocketProvider>);
    const ws = MockWebSocket.latest();
    unmount();
    expect(ws.closed).toBe(true);
    // onclose should be nulled before close so the reconnect timer is NOT set
    // (if onclose were not nulled, the close handler would schedule a reconnect)
    expect(ws.onclose).toBeNull();
  });
});

// ─── Context value ────────────────────────────────────────────────────────────

describe('useSocketContext', () => {
  it('returns null outside a provider', () => {
    let ctx: ReturnType<typeof useSocketContext> = 'NOT_SET' as never;
    function Spy() { ctx = useSocketContext(); return null; }
    render(<Spy />);
    expect(ctx).toBeNull();
  });

  it('returns a context value with subscribe inside a provider', () => {
    let ctx: ReturnType<typeof useSocketContext> = null;
    function Spy() { ctx = useSocketContext(); return null; }
    render(<ResultsSocketProvider><Spy /></ResultsSocketProvider>);
    expect(ctx).not.toBeNull();
    expect(typeof ctx!.subscribe).toBe('function');
  });
});

// ─── Subscribe / event dispatch ───────────────────────────────────────────────

describe('ResultsSocketProvider — message dispatch', () => {
  it('dispatches parsed WebSocket messages to subscribers', async () => {
    const received: unknown[] = [];
    render(
      <ResultsSocketProvider>
        <Receiver onEvent={e => received.push(e)} />
      </ResultsSocketProvider>
    );

    const ws = MockWebSocket.latest();
    await act(async () => { ws.open(); });
    await act(async () => {
      ws.receive({ type: 'test:status', testId: 'abc', status: 'completed' });
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: 'test:status', testId: 'abc' });
  });

  it('dispatches to multiple subscribers', async () => {
    const log1: unknown[] = [];
    const log2: unknown[] = [];

    function TwoSubscribers() {
      const ctx = useSocketContext();
      if (ctx) {
        ctx.subscribe(e => log1.push(e));
        ctx.subscribe(e => log2.push(e));
      }
      return null;
    }

    render(<ResultsSocketProvider><TwoSubscribers /></ResultsSocketProvider>);
    const ws = MockWebSocket.latest();
    await act(async () => { ws.open(); });
    await act(async () => { ws.receive({ type: 'tests:changed' }); });

    expect(log1).toHaveLength(1);
    expect(log2).toHaveLength(1);
  });

  it('ignores malformed (non-JSON) WebSocket messages', async () => {
    const received: unknown[] = [];
    render(
      <ResultsSocketProvider>
        <Receiver onEvent={e => received.push(e)} />
      </ResultsSocketProvider>
    );

    const ws = MockWebSocket.latest();
    await act(async () => { ws.open(); });
    await act(async () => {
      ws.onmessage?.({ data: 'not-json{{{' });
    });

    expect(received).toHaveLength(0);
  });
});

// ─── subscribe returns unsubscribe ────────────────────────────────────────────

describe('subscribe → unsubscribe', () => {
  it('unsubscribed listeners no longer receive events', async () => {
    const received: unknown[] = [];
    let unsubscribe!: () => void;

    function Sub() {
      const ctx = useSocketContext();
      if (ctx) unsubscribe = ctx.subscribe(e => received.push(e));
      return null;
    }

    render(<ResultsSocketProvider><Sub /></ResultsSocketProvider>);
    const ws = MockWebSocket.latest();
    await act(async () => { ws.open(); });
    await act(async () => { ws.receive({ type: 'tests:changed' }); });
    expect(received).toHaveLength(1);

    unsubscribe();
    await act(async () => { ws.receive({ type: 'tests:changed' }); });
    expect(received).toHaveLength(1); // no new events after unsubscribe
  });
});

// ─── Reconnect on unexpected close ───────────────────────────────────────────

describe('ResultsSocketProvider — reconnect', () => {
  it('emits synthetic reconnected event after WebSocket re-opens', async () => {
    vi.useFakeTimers();
    const received: unknown[] = [];

    render(
      <ResultsSocketProvider>
        <Receiver onEvent={e => received.push(e)} />
      </ResultsSocketProvider>
    );

    const ws1 = MockWebSocket.latest();
    await act(async () => { ws1.open(); });

    // First message to mark everConnected = true
    await act(async () => { ws1.receive({ type: 'tests:changed' }); });

    // Simulate unexpected close → should schedule reconnect
    await act(async () => { ws1.close(); });

    // Advance timer to trigger reconnect
    await act(async () => { vi.advanceTimersByTime(1100); });

    const ws2 = MockWebSocket.latest();
    expect(ws2).not.toBe(ws1);
    await act(async () => { ws2.open(); });

    // Should emit 'reconnected' synthetic event
    const reconnected = received.filter(e => (e as { type: string }).type === 'reconnected');
    expect(reconnected).toHaveLength(1);

    vi.useRealTimers();
  });
});
