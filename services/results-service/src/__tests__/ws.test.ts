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
  send:    ReturnType<typeof vi.fn>;
  on:      ReturnType<typeof vi.fn>;
  /** Trigger a registered event handler (e.g. 'close') */
  _trigger: (event: string) => void;
}

const makeMockWS = (readyState = WS_OPEN): MockWS => {
  const handlers: Record<string, () => void> = {};
  return {
    readyState,
    send: vi.fn(),
    on:   vi.fn((event: string, cb: () => void) => { handlers[event] = cb; }),
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
      }
      return { WebSocketServer: MockWebSocketServer, WebSocket: MockWebSocket };
    });

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

      expect(JSON.parse(ws.send.mock.calls[0][0])).toEqual(event);
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

      expect(JSON.parse(ws.send.mock.calls[0][0])).toEqual(event);
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
});
