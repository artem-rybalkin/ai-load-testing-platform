import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { getSystemHealth, ServiceHealth } from '@/lib/api';

interface SystemHealthData {
  services: ServiceHealth[];
}

const HealthContext = createContext<SystemHealthData>({ services: [] });

export function HealthProvider({ children }: { children: ReactNode }) {
  const [services, setServices] = useState<ServiceHealth[]>([]);

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

  return (
    <HealthContext.Provider value={{ services }}>
      {children}
    </HealthContext.Provider>
  );
}

export const useHealth = () => useContext(HealthContext);
