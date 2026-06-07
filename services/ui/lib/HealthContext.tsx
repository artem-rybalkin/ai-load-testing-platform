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
        setServices(data.services);
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
