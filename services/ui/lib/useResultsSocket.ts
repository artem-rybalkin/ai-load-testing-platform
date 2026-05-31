import { useEffect, useRef } from 'react';
import { useSocketContext } from './ResultsSocketContext';
import type { LiveMetricPoint } from './api';

export type WSEvent =
  | { type: 'test:status'; testId: string; status: string; perfStatus?: string | null }
  | { type: 'test:live';   testId: string; point: LiveMetricPoint }
  | { type: 'tests:changed' }
  | { type: 'reconnected' }; // synthetic — emitted by the provider, never sent by the server

/**
 * Subscribes to the shared WebSocket connection managed by `ResultsSocketProvider`.
 * Calls `onEvent` for each push event. Safe to call from any client component.
 *
 * The connection itself lives in the provider (layout.tsx) — all components
 * that call this hook share one underlying WebSocket.
 */
export function useResultsSocket(onEvent: (event: WSEvent) => void): void {
  // Keep a stable ref to the latest callback so subscription changes don't
  // cause the effect to re-run and re-subscribe.
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const ctx = useSocketContext();

  useEffect(() => {
    if (!ctx) return;
    return ctx.subscribe(event => onEventRef.current(event));
  }, [ctx]); // ctx is the stable valueRef.current — runs exactly once
}
