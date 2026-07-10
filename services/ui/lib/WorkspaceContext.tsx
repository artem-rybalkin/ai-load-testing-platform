import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import type { Workspace } from '@alt/shared';
import { getWorkspaces } from '@/lib/api';
import { useAuth } from '@/lib/AuthContext';

interface WorkspaceContextValue {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  setActiveWorkspaceId: (id: string | null) => void;
  refetch: () => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceContextValue>({
  workspaces: [],
  activeWorkspaceId: null,
  setActiveWorkspaceId: () => {},
  refetch: async () => {},
});

export const useWorkspace = () => useContext(WorkspaceContext);

// Exported so route loaders (which run outside the React tree, no context
// access) can read the persisted active-workspace selection directly.
export function storageKey(teamId: string) {
  return `activeWorkspace_${teamId}`;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceIdState] = useState<string | null>(null);

  const teamId = user?.currentTeamId ?? null;

  const refetch = useCallback(async () => {
    if (!teamId) { setWorkspaces([]); return; }
    try {
      const { workspaces: list } = await getWorkspaces();
      setWorkspaces(list);
      // Remove stale selection if the workspace was deleted
      setActiveWorkspaceIdState(prev => {
        if (prev && !list.find(w => w.id === prev)) return null;
        return prev;
      });
    } catch {
      setWorkspaces([]);
    }
  }, [teamId]);

  // Reload workspaces whenever the team changes
  useEffect(() => {
    if (authLoading) return;
    if (!teamId) { setWorkspaces([]); setActiveWorkspaceIdState(null); return; }
    // Restore persisted selection for this team
    const stored = localStorage.getItem(storageKey(teamId));
    setActiveWorkspaceIdState(stored ?? null);
    refetch();
  }, [teamId, authLoading, refetch]);

  const setActiveWorkspaceId = useCallback((id: string | null) => {
    setActiveWorkspaceIdState(id);
    if (teamId) {
      if (id) localStorage.setItem(storageKey(teamId), id);
      else localStorage.removeItem(storageKey(teamId));
    }
  }, [teamId]);

  return (
    <WorkspaceContext.Provider value={{ workspaces, activeWorkspaceId, setActiveWorkspaceId, refetch }}>
      {children}
    </WorkspaceContext.Provider>
  );
}
