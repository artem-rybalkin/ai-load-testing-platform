/**
 * Unit tests for results-service/src/ws.ts
 *
 * ws.ts maintains a module-private `clients` Set<WebSocket>. To isolate that
 * state between tests we must call vi.resetModules() in beforeEach and
 * re-import the module dynamically after installing a fresh mock for the 'ws'
 * package. An EventEmitter standing in for http.Server lets us emit the
 * 'upgrade' event and drive the internal handleUpgrade path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type * as WsTypes from '../ws';

// ── WebSocket readyState constants ────────────────────────────────────────────
const WS_OPEN    = 1;
const WS_CLOSING = 2;

// ── Mock WebSocket helper ─────────────────────────────────────────────────────

interface MockWS {
  readyState: number;
  send:      ReturnType<typeof vi.fn>;
  on:        ReturnType<typeof vi.fn>;
  ping:      ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  /** Trigger a registered event handler (e.g. 'close') */
  _trigger: (event: string) => void;
}

const makeMockWS = (readyState = WS_OPEN): MockWS => {
  const handlers: Record<string, () => void> = {};
  return {
    readyState,
    send:      vi.fn(),
    on:        vi.fn((event: string, cb: () => void) => { handlers[event] = cb; }),
    ping:      vi.fn(),
    terminate: vi.fn(),
    _trigger: (event: string) => handlers[event]?.(),
  };
};

// ── Test suite ────────────────────────────────────────────────────────────────

describe('ws module', () => {
  let wsMod: typeof WsTypes;
  let mockHandleUpgrade: ReturnType<typeof vi.fn>;
  let lastUpgradeCallback: ((ws: MockWS) => void) | null;
  let mockServer: EventEmitter;

  beforeEach(async () => {
    // Fresh module registry → fresh `clients` Set for every test
    vi.resetModules();
    lastUpgradeCallback = null;

    // Capture the handleUpgrade callback so tests can inject mock WebSockets
    mockHandleUpgrade = vi.fn(
      (_req: unknown, _socket: unknown, _head: unknown, cb: (ws: MockWS) => void) => {
        lastUpgradeCallback = cb;
      },
    );

    vi.doMock('ws', () => {
      class MockWebSocket {
        static OPEN    = WS_OPEN;
        static CLOSING = WS_CLOSING;
      }
      class MockWebSocketServer {
        handleUpgrade = mockHandleUpgrade;
        on = vi.fn();
      }
      return { WebSocketServer: MockWebSocketServer, WebSocket: MockWebSocket };
    });

    // Explicit here (not just relying on real env state) so this outer
    // beforeEach never depends on a `vi.doMock('../redis', ...)` registration
    // left over from the "Redis pub/sub broadcast" describe below — doMock
    // bindings aren't cleared by vi.resetModules() alone, and with the
    // project's global mockReset: true, a stale binding's captured vi.fn()
    // from a previous test comes back with its implementation wiped instead
    // of just being a harmless no-op.
    vi.doMock('../redis', () => ({ redisClient: undefined }));

    wsMod      = await import('../ws') as typeof WsTypes;
    mockServer = new EventEmitter();
    wsMod.setupWebSocketServer(mockServer as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Simulate a browser connecting via the /ws upgrade path.
   * Emits the HTTP 'upgrade' event on the mock server, then invokes the
   * handleUpgrade callback with the supplied mock WebSocket.
   */
  const connectClient = (ws: MockWS): void => {
    const fakeSocket = { destroy: vi.fn() };
    mockServer.emit('upgrade', { url: '/ws' }, fakeSocket, Buffer.alloc(0));
    lastUpgradeCallback!(ws);
  };

  // ── broadcast() ────────────────────────────────────────────────────────────

  describe('broadcast', () => {
    it('is a no-op when there are no connected clients', () => {
      expect(() => wsMod.broadcast({ type: 'tests:changed' })).not.toThrow();
    });

    it('sends a JSON-serialised tests:changed event to an OPEN client', () => {
      const ws = makeMockWS(WS_OPEN);
      connectClient(ws);

      wsMod.broadcast({ type: 'tests:changed' });

      expect(ws.send).toHaveBeenCalledOnce();
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'tests:changed' }));
    });

    it('sends correct payload for a test:status event', () => {
      const ws    = makeMockWS(WS_OPEN);
      connectClient(ws);
      const event = {
        type:       'test:status' as const,
        testId:     'abc-123',
        status:     'completed',
        perfStatus: 'passed',
      };

      wsMod.broadcast(event);

      expect(JSON.parse(ws.send.mock.calls[0]![0])).toEqual(event);
    });

    it('sends correct payload for a test:live event', () => {
      const ws    = makeMockWS(WS_OPEN);
      connectClient(ws);
      const event = {
        type:   'test:live' as const,
        testId: 'abc-123',
        point:  {
          timestamp:       '2025-01-01T00:00:00Z',
          vus:             10,
          rps:             5,
          avgResponseTime: 100,
          errorRate:       0,
        } as never,
      };

      wsMod.broadcast(event);

      expect(JSON.parse(ws.send.mock.calls[0]![0])).toEqual(event);
    });

    it('does NOT send to a non-OPEN (CLOSING) client', () => {
      const ws = makeMockWS(WS_CLOSING);
      connectClient(ws);

      wsMod.broadcast({ type: 'tests:changed' });

      expect(ws.send).not.toHaveBeenCalled();
    });

    it('removes a non-OPEN client from the set after a broadcast attempt', () => {
      const closingWs = makeMockWS(WS_CLOSING);
      const openWs    = makeMockWS(WS_OPEN);
      connectClient(closingWs);

      // First broadcast prunes closingWs
      wsMod.broadcast({ type: 'tests:changed' });

      // Now connect an OPEN client and verify only it gets the next message
      connectClient(openWs);
      wsMod.broadcast({ type: 'tests:changed' });

      expect(closingWs.send).not.toHaveBeenCalled();
      expect(openWs.send).toHaveBeenCalledOnce();
    });

    it('removes a client that throws on send and does not rethrow', () => {
      const ws = makeMockWS(WS_OPEN);
      ws.send.mockImplementation(() => { throw new Error('send failed'); });
      connectClient(ws);

      // First broadcast — send throws, client removed, no rethrow
      expect(() => wsMod.broadcast({ type: 'tests:changed' })).not.toThrow();

      // Second broadcast — client is gone so send is never called again
      ws.send.mockClear();
      wsMod.broadcast({ type: 'tests:changed' });
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('sends to multiple OPEN clients simultaneously', () => {
      const ws1 = makeMockWS(WS_OPEN);
      const ws2 = makeMockWS(WS_OPEN);
      const ws3 = makeMockWS(WS_OPEN);
      connectClient(ws1);
      connectClient(ws2);
      connectClient(ws3);

      wsMod.broadcast({ type: 'tests:changed' });

      expect(ws1.send).toHaveBeenCalledOnce();
      expect(ws2.send).toHaveBeenCalledOnce();
      expect(ws3.send).toHaveBeenCalledOnce();
    });

    it('sends only to OPEN clients in a mixed-state set', () => {
      const openWs    = makeMockWS(WS_OPEN);
      const closingWs = makeMockWS(WS_CLOSING);
      connectClient(openWs);
      connectClient(closingWs);

      wsMod.broadcast({ type: 'tests:changed' });

      expect(openWs.send).toHaveBeenCalledOnce();
      expect(closingWs.send).not.toHaveBeenCalled();
    });
  });

  // ── Redis pub/sub (horizontal scaling) ────────────────────────────────────────

  describe('Redis pub/sub broadcast', () => {
    let subscriberMock: { on: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> };
    let publishMock: ReturnType<typeof vi.fn>;
    let messageHandler: (channel: string, message: string) => void;

    beforeEach(async () => {
      vi.resetModules();

      subscriberMock = {
        on: vi.fn((event: string, cb: (channel: string, message: string) => void) => {
          if (event === 'message') messageHandler = cb;
        }),
        subscribe: vi.fn().mockResolvedValue(undefined),
      };
      publishMock = vi.fn().mockResolvedValue(1);

      vi.doMock('../redis', () => ({
        redisClient: {
          duplicate: (): typeof subscriberMock => subscriberMock,
          publish: publishMock,
        },
      }));

      vi.doMock('ws', () => {
        class MockWebSocket {
          static OPEN    = WS_OPEN;
          static CLOSING = WS_CLOSING;
        }
        class MockWebSocketServer {
          handleUpgrade = mockHandleUpgrade;
          on = vi.fn();
        }
        return { WebSocketServer: MockWebSocketServer, WebSocket: MockWebSocket };
      });

      mockHandleUpgrade = vi.fn(
        (_req: unknown, _socket: unknown, _head: unknown, cb: (ws: MockWS) => void) => {
          lastUpgradeCallback = cb;
        },
      );

      wsMod      = await import('../ws') as typeof WsTypes;
      mockServer = new EventEmitter();
      wsMod.setupWebSocketServer(mockServer as never);
    });

    it('subscribes to the ws:broadcast channel on a duplicated connection', () => {
      expect(subscriberMock.subscribe).toHaveBeenCalledWith('ws:broadcast');
    });

    it('publishes broadcast events to Redis in addition to local delivery', () => {
      const ws = makeMockWS(WS_OPEN);
      connectClient(ws);

      wsMod.broadcast({ type: 'tests:changed' });

      // Local delivery still happens
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'tests:changed' }));

      // And the event is published for other replicas
      expect(publishMock).toHaveBeenCalledOnce();
      const [channel, payload] = publishMock.mock.calls[0]!;
      expect(channel).toBe('ws:broadcast');
      const parsed = JSON.parse(payload);
      expect(parsed.event).toEqual({ type: 'tests:changed' });
      expect(typeof parsed.origin).toBe('string');
    });

    it('forwards events received from other replicas to local clients', () => {
      const ws = makeMockWS(WS_OPEN);
      connectClient(ws);

      messageHandler('ws:broadcast', JSON.stringify({
        origin: 'other-replica-id',
        event:  { type: 'tests:changed' },
      }));

      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'tests:changed' }));
    });

    it('does not re-deliver an event originating from this replica (avoids double-send)', () => {
      const ws = makeMockWS(WS_OPEN);
      connectClient(ws);

      // Trigger a local broadcast to learn this replica's origin id
      wsMod.broadcast({ type: 'tests:changed' });
      const ownOrigin = JSON.parse(publishMock.mock.calls[0]![1]).origin;
      ws.send.mockClear();

      // Simulate Redis echoing the same message back to this replica
      messageHandler('ws:broadcast', JSON.stringify({
        origin: ownOrigin,
        event:  { type: 'tests:changed' },
      }));

      expect(ws.send).not.toHaveBeenCalled();
    });

    it('ignores messages on unrelated Redis channels', () => {
      const ws = makeMockWS(WS_OPEN);
      connectClient(ws);

      messageHandler('some-other-channel', JSON.stringify({
        origin: 'other-replica-id',
        event:  { type: 'tests:changed' },
      }));

      expect(ws.send).not.toHaveBeenCalled();
    });

    it('does not throw on malformed pub/sub payloads', () => {
      connectClient(makeMockWS(WS_OPEN));

      expect(() => messageHandler('ws:broadcast', 'not-json')).not.toThrow();
    });
  });

  // ── setupWebSocketServer() ──────────────────────────────────────────────────

  describe('setupWebSocketServer', () => {
    it('calls handleUpgrade for upgrade requests to /ws', () => {
      const fakeSocket = { destroy: vi.fn() };
      mockServer.emit('upgrade', { url: '/ws' }, fakeSocket, Buffer.alloc(0));

      expect(mockHandleUpgrade).toHaveBeenCalledOnce();
    });

    it('calls socket.destroy() for upgrade requests to non-/ws paths', () => {
      const fakeSocket = { destroy: vi.fn() };
      mockServer.emit('upgrade', { url: '/metrics' }, fakeSocket, Buffer.alloc(0));

      expect(mockHandleUpgrade).not.toHaveBeenCalled();
      expect(fakeSocket.destroy).toHaveBeenCalledOnce();
    });

    it('adds the client to the broadcast set when upgrade completes', () => {
      const ws = makeMockWS(WS_OPEN);
      connectClient(ws);

      wsMod.broadcast({ type: 'tests:changed' });

      expect(ws.send).toHaveBeenCalledOnce();
    });

    it("removes the client when the client emits 'close'", () => {
      const ws = makeMockWS(WS_OPEN);
      connectClient(ws);

      ws._trigger('close');    // simulate browser disconnect

      wsMod.broadcast({ type: 'tests:changed' });
      expect(ws.send).not.toHaveBeenCalled();
    });
  });

  // ── Heartbeat (zombie-connection detection) ───────────────────────────────

  describe('heartbeat', () => {
    // Fake timers must be installed BEFORE setupWebSocketServer() runs, since
    // its setInterval() is only fake-clock-controllable if it's created while
    // fake timers are already active — the outer beforeEach's module import
    // (real timers) runs first, so re-do that setup here with fake timers on.
    beforeEach(async () => {
      vi.useFakeTimers();
      vi.resetModules();
      lastUpgradeCallback = null;

      mockHandleUpgrade = vi.fn(
        (_req: unknown, _socket: unknown, _head: unknown, cb: (ws: MockWS) => void) => {
          lastUpgradeCallback = cb;
        },
      );

      vi.doMock('ws', () => {
        class MockWebSocket {
          static OPEN    = WS_OPEN;
          static CLOSING = WS_CLOSING;
        }
        class MockWebSocketServer {
          handleUpgrade = mockHandleUpgrade;
          on = vi.fn();
        }
        return { WebSocketServer: MockWebSocketServer, WebSocket: MockWebSocket };
      });

      wsMod      = await import('../ws') as typeof WsTypes;
      mockServer = new EventEmitter();
      wsMod.setupWebSocketServer(mockServer as never);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('pings every connected client every 30s', () => {
      const ws = makeMockWS(WS_OPEN);
      connectClient(ws);

      vi.advanceTimersByTime(30000);

      expect(ws.ping).toHaveBeenCalledOnce();
      expect(ws.terminate).not.toHaveBeenCalled();
    });

    it('terminates and removes a client that never responds with pong', () => {
      const ws = makeMockWS(WS_OPEN);
      connectClient(ws);

      vi.advanceTimersByTime(30000); // first ping sent, isAlive marked false
      vi.advanceTimersByTime(30000); // no pong arrived — client is a zombie

      expect(ws.terminate).toHaveBeenCalledOnce();

      wsMod.broadcast({ type: 'tests:changed' });
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('keeps a client alive across multiple intervals when it responds with pong', () => {
      const ws = makeMockWS(WS_OPEN);
      connectClient(ws);

      vi.advanceTimersByTime(30000); // first ping sent
      ws._trigger('pong');           // client responds in time
      vi.advanceTimersByTime(30000); // second sweep — should NOT terminate

      expect(ws.terminate).not.toHaveBeenCalled();
      expect(ws.ping).toHaveBeenCalledTimes(2);

      wsMod.broadcast({ type: 'tests:changed' });
      expect(ws.send).toHaveBeenCalledOnce();
    });
  });
});
