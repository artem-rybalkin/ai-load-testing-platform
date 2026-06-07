import { createContext, useContext, useEffect, useRef } from 'react';
import type { WSEvent } from './useResultsSocket';

type Listener = (event: WSEvent) => void;
type SocketContextValue = { subscribe: (fn: Listener) => () => void };

export const ResultsSocketContext = createContext<SocketContextValue | null>(null);

/**
 * Renders a single shared WebSocket connection for the entire app tree.
 * Place once in layout — all `useResultsSocket` calls subscribe to this
 * connection instead of each opening their own.
 */
export function ResultsSocketProvider({ children }: { children: React.ReactNode }) {
  const listenersRef = useRef(new Set<Listener>());

  // Stable context value — identity never changes, so useEffect deps in
  // consumers run exactly once regardless of re-renders here.
  const valueRef = useRef<SocketContextValue>({
    subscribe: (fn) => {
      listenersRef.current.add(fn);
      return () => { listenersRef.current.delete(fn); };
    },
  });

  useEffect(() => {
    const emit = (event: WSEvent) => {
      listenersRef.current.forEach(fn => { try { fn(event); } catch { /* guard against listener errors */ } });
    };

    // Use same-origin WebSocket through the Vite proxy (/data → results-service)
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/data/ws`;

    let ws: WebSocket | null = null;
    let delay = 1_000;
    let dead = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let everConnected = false;

    const connect = () => {
      ws = new WebSocket(url);
      ws.onmessage = e => {
        try { emit(JSON.parse(e.data as string) as WSEvent); } catch { /* ignore malformed */ }
      };
      ws.onclose = () => {
        if (dead) return;
        reconnectTimer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30_000);
      };
      ws.onopen = () => {
        delay = 1_000;
        if (everConnected) emit({ type: 'reconnected' });
        everConnected = true;
      };
    };

    connect();

    return () => {
      dead = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      if (ws) {
        ws.onclose = null; // prevent the reconnect handler from firing on intentional close
        ws.close();
      }
    };
  }, []);

  return (
    <ResultsSocketContext.Provider value={valueRef.current}>
      {children}
    </ResultsSocketContext.Provider>
  );
}

export function useSocketContext() {
  return useContext(ResultsSocketContext);
}
