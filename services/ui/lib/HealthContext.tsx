import { createContext, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { getSystemHealth, getActiveTests, ServiceHealth, ActiveTest } from '@/lib/api';
import { useResultsSocket } from '@/lib/useResultsSocket';

interface SystemHealthData {
  services: ServiceHealth[];
  activeTests: ActiveTest[];
}

const HealthContext = createContext<SystemHealthData>({ services: [], activeTests: [] });

export function HealthProvider({ children }: { children: ReactNode }) {
  const [services, setServices] = useState<ServiceHealth[]>([]);
  const [activeTests, setActiveTests] = useState<ActiveTest[]>([]);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const poll = async () => {
      try {
        const data = await getSystemHealth();
        // A 401 (e.g. polled before the session cookie exists, right after login)
        // returns `{ error: ... }` with no `services` array — treat like a network error.
        if (Array.isArray(data?.services)) setServices(data.services);
      } catch { /* network error — don't surface */ }
    };
    poll();
    const interval = setInterval(poll, 15000);
    return () => clearInterval(interval);
  }, []);

  const refreshActiveTests = async () => {
    try { setActiveTests((await getActiveTests()).active ?? []); } catch { /* non-fatal */ }
  };
  useEffect(() => { refreshActiveTests(); }, []);

  // Single shared fetch + subscription for active-tests data — Sidebar, ActiveTests,
  // and the home page each used to poll/subscribe independently, tripling the same
  // request on every WS event. Debounced 50ms since the consumer broadcasts both
  // test:status + tests:changed together for the same transition.
  useResultsSocket((event) => {
    if (event.type === 'tests:changed' || event.type === 'test:status' || event.type === 'reconnected') {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(refreshActiveTests, 50);
    }
  });

  return (
    <HealthContext.Provider value={{ services, activeTests }}>
      {children}
    </HealthContext.Provider>
  );
}

export const useHealth = () => useContext(HealthContext);
