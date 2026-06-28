import { f, RESULTS_URL } from './core';
import type { Workspace } from '@alt/shared';

export type { Workspace };

export const getWorkspaces = async (): Promise<{ workspaces: Workspace[] }> => {
  const res = await f(`${RESULTS_URL}/workspaces`, { cache: 'no-store' });
  if (!res.ok) return { workspaces: [] };
  return res.json();
};

export const createWorkspace = async (data: { name: string; description?: string }): Promise<{ workspace: Workspace }> => {
  const res = await f(`${RESULTS_URL}/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? 'Failed to create workspace');
  return { workspace: body };
};

export const updateWorkspace = async (id: string, data: { name?: string; description?: string }): Promise<{ workspace: Workspace }> => {
  const res = await f(`${RESULTS_URL}/workspaces/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? 'Failed to update workspace');
  return { workspace: body };
};

export const deleteWorkspace = async (id: string): Promise<void> => {
  const res = await f(`${RESULTS_URL}/workspaces/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? 'Failed to delete workspace');
  }
};
