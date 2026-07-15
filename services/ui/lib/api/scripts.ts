import type { SavedScript, SavedScriptVersion, ScriptEditResponse, ChatMessage } from '@alt/shared';
import { f, RESULTS_URL } from './core';

export const getScripts = async (workspaceId?: string | null): Promise<{ scripts: SavedScript[] }> => {
  const params = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
  const res = await f(`${RESULTS_URL}/scripts${params}`, { cache: 'no-store' });
  return res.json();
};

export const getScript = async (id: string): Promise<{ script: SavedScript }> => {
  const res = await f(`${RESULTS_URL}/scripts/${id}`, { cache: 'no-store' });
  return res.json();
};

export const getScriptVersions = async (id: string): Promise<{ versions: SavedScriptVersion[] }> => {
  const res = await f(`${RESULTS_URL}/scripts/${id}/versions`, { cache: 'no-store' });
  return res.json();
};

export const saveScript = async (id: string, script: string): Promise<void> => {
  const res = await f(`${RESULTS_URL}/scripts/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ script }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
};

export const restoreScriptVersion = async (id: string, versionId: string): Promise<void> => {
  const res = await f(`${RESULTS_URL}/scripts/${id}/versions/${versionId}/restore`, { method: 'POST' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
};

export const editScriptChat = async (scriptId: string, messages: ChatMessage[]): Promise<ScriptEditResponse> => {
  const res = await f(`${RESULTS_URL}/chat/edit-script`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scriptId, messages }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
};
