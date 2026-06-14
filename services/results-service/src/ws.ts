import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { randomUUID } from 'crypto';
import { LiveMetricPoint } from '@alt/shared';
import { redisClient } from './redis';
import { log } from './logger';

export type WSEvent =
  | { type: 'test:status'; testId: string; status: string; perfStatus?: string | null }
  | { type: 'test:live';   testId: string; point: LiveMetricPoint }
  | { type: 'tests:changed' };

const clients = new Set<WebSocket>();

// Redis pub/sub lets `broadcast()` reach all horizontally-scaled replicas;
// each replica forwards received events to its own locally-connected clients.
const PUBSUB_CHANNEL = 'ws:broadcast';
const INSTANCE_ID = randomUUID();
const subscriber = redisClient?.duplicate();

const deliverLocal = (event: WSEvent): void => {
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

if (subscriber) {
  subscriber.on('error', (err) => log.warn({ err }, 'Redis pub/sub subscriber error'));
  subscriber.subscribe(PUBSUB_CHANNEL).catch((err) =>
    log.warn({ err }, 'Failed to subscribe to ws broadcast channel'),
  );
  subscriber.on('message', (channel, message) => {
    if (channel !== PUBSUB_CHANNEL) return;
    try {
      const { origin, event } = JSON.parse(message) as { origin: string; event: WSEvent };
      if (origin === INSTANCE_ID) return; // already delivered locally by this replica
      deliverLocal(event);
    } catch (err) {
      log.warn({ err }, 'Failed to parse ws broadcast message');
    }
  });
}

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
  deliverLocal(event);
  if (redisClient) {
    redisClient
      .publish(PUBSUB_CHANNEL, JSON.stringify({ origin: INSTANCE_ID, event }))
      .catch((err) => log.warn({ err }, 'Failed to publish ws broadcast event'));
  }
};
