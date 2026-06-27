import { f, orgJson, RESULTS_URL } from './core';

export interface TeamApiKeyRow { id: string; name: string; createdAt: string; lastUsedAt: string | null; revoked: boolean }
export interface TeamApiKeyCreated { id: string; name: string; key: string; createdAt: string }

export const getTeamApiKeys = (teamId: string): Promise<TeamApiKeyRow[]> =>
  f(`${RESULTS_URL}/teams/${teamId}/api-keys`).then(orgJson<TeamApiKeyRow[]>());

export const createTeamApiKey = (teamId: string, name: string): Promise<TeamApiKeyCreated> =>
  f(`${RESULTS_URL}/teams/${teamId}/api-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then(orgJson<TeamApiKeyCreated>());

export const revokeTeamApiKey = (teamId: string, keyId: string): Promise<{ success: boolean }> =>
  f(`${RESULTS_URL}/teams/${teamId}/api-keys/${keyId}`, { method: 'DELETE' }).then(orgJson<{ success: boolean }>());
