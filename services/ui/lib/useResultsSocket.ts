'use client';

import { useEffect, useRef } from 'react';
import type { LiveMetricPoint } from './api';

export type WSEvent =
  | { type: 'test:status'; testId: string; status: string; perfStatus?: string | null }
  | { type: 'test:live';   testId: string; point: LiveMetricPoint }
  | { type: 'tests:changed' }
  | { type: 'reconnected' }; // synthetic — emitted by the hook, never sent by the server

/**
 * Connects to the results-service WebSocket endpoint and calls `onEvent` for
 * each push event received. Auto-reconnects with exponential backoff (max 30s).
 *
 * Safe to call from any client component — the connection is opened once on
 * mount and torn down on unmount.
 */
export function useResultsSocket(onEvent: (event: WSEvent) => void): void {
  // Keep a stable ref to the latest callback so reconnects don't re-run this effect
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    const base = (process.env.NEXT_PUBLIC_RESULTS_URL ?? 'http://localhost:3004')
      .replace(/^http/, 'ws');
    const url = `${base}/ws`;

    let ws: WebSocket | null = null;
    let delay = 1_000;
    let dead = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let everConnected = false;

    const connect = () => {
      ws = new WebSocket(url);

      ws.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data as string) as WSEvent;
          onEventRef.current(event);
        } catch { /* ignore malformed messages */ }
      };

      ws.onclose = () => {
        if (dead) return;
        // Exponential backoff: 1s → 2s → 4s → … → 30s
        reconnectTimer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30_000);
      };

      ws.onopen = () => {
        delay = 1_000;
        if (everConnected) {
          // Emit synthetic event so components can re-fetch state missed during the gap
          onEventRef.current({ type: 'reconnected' });
        }
        everConnected = true;
      };
    };

    connect();

    return () => {
      dead = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, []); // intentionally empty — connection is stable for component lifetime
}
