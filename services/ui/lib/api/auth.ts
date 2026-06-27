import type { SessionUser } from '@alt/shared';
import { f, RESULTS_URL } from './core';

export type { SessionUser };

const authJson = async (res: Response): Promise<SessionUser> => {
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
};

export const register = (email: string, password: string, teamName: string, name?: string): Promise<SessionUser> =>
  f(`${RESULTS_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, teamName, name }),
  }).then(authJson);

export const login = (email: string, password: string): Promise<SessionUser> =>
  f(`${RESULTS_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }).then(authJson);

export const logout = (): Promise<void> =>
  f(`${RESULTS_URL}/auth/logout`, { method: 'POST' }).then(() => undefined);

export const getMe = (): Promise<SessionUser> =>
  f(`${RESULTS_URL}/auth/me`).then(r => {
    if (!r.ok) throw new Error('Not authenticated');
    return r.json();
  });

export const switchTeam = (teamId: string): Promise<SessionUser> =>
  f(`${RESULTS_URL}/auth/switch-team`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId }),
  }).then(authJson);
