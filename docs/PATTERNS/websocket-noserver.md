# Pattern: WebSocket Server (noServer mode on Fastify v5)

## Context
Used in: results-service/src/ws.ts

## Problem
@fastify/websocket requires Fastify ^4.x. Project uses Fastify v5. Need WebSocket support without breaking API compatibility.

## Solution

```typescript
import { WebSocketServer, WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';

const clients = new Set<WebSocket>();

export function setupWebSocketServer(app: FastifyInstance) {
  const wss = new WebSocketServer({ noServer: true });

  app.server.on('upgrade', (req, socket, head) => {
    if (req.url === '/ws') {
      wss.handleUpgrade(req, socket as any, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    }
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });
}

export function broadcast(event: object) {
  const data = JSON.stringify(event);
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  });
}
```

## Event Types
- `{ type: 'test:status', testId, status, perfStatus }` — status change
- `{ type: 'test:live', testId, point }` — live metric point
- `{ type: 'tests:changed' }` — any list change

## Key Rules
- noServer attaches to the underlying HTTP server, works with any Fastify version
- Never use @fastify/websocket with Fastify v5
- Auto-remove closed/errored sockets from the Set
- In-process Set is sufficient for single-instance; use Redis pub/sub for horizontal scaling
