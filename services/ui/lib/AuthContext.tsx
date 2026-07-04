import { createContext, useContext, useEffect, useState, useCallback, useMemo, ReactNode } from 'react';
import { SessionUser, getMe, logout as apiLogout, switchTeam as apiSwitchTeam } from '@/lib/api';

interface AuthContextValue {
  user: SessionUser | null;
  loading: boolean;
  logout: () => Promise<void>;
  setUser: (u: SessionUser | null) => void;
  switchTeam: (teamId: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null, loading: true, logout: async () => {}, setUser: () => {}, switchTeam: async () => {},
});

export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getMe()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const logout = useCallback(async () => {
    await apiLogout();
    setUser(null);
  }, []);

  const switchTeam = useCallback(async (teamId: string) => {
    const updated = await apiSwitchTeam(teamId);
    setUser(updated);
  }, []);

  // Stable value identity so useAuth() consumers only re-render when user/loading
  // actually change, not on every AuthProvider render.
  const value = useMemo(
    () => ({ user, loading, logout, setUser, switchTeam }),
    [user, loading, logout, switchTeam],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}
