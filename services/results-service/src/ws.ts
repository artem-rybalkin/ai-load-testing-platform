import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { LiveMetricPoint } from '@alt/shared';

export type WSEvent =
  | { type: 'test:status'; testId: string; status: string; perfStatus?: string | null }
  | { type: 'test:live';   testId: string; point: LiveMetricPoint }
  | { type: 'tests:changed' };

const clients = new Set<WebSocket>();

/**
 * Attach a WebSocket server to the given HTTP server (Fastify's underlying
 * server). Handles the HTTP→WS upgrade for GET /ws without requiring any
 * Fastify plugin — compatible with all Fastify versions.
 */
export const setupWebSocketServer = (server: Server): void => {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        clients.add(ws);
        ws.on('close', () => clients.delete(ws));
        ws.on('error', () => clients.delete(ws));
      });
    } else {
      socket.destroy();
    }
  });
};

export const broadcast = (event: WSEvent): void => {
  if (clients.size === 0) return;
  const msg = JSON.stringify(event);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg); } catch { clients.delete(ws); }
    } else {
      clients.delete(ws);
    }
  }
};
