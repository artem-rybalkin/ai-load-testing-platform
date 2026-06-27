// Shared fetch infrastructure — base URLs, auth headers, fetch wrapper, response helper.
// All domain modules import from here; nothing else should be imported by consumers directly.

export const API_URL     = '/api';
export const RESULTS_URL = '/data';
// RECORDER_URL keeps its absolute URL for the opener window
export const RECORDER_URL = import.meta.env.VITE_RECORDER_URL || 'http://localhost:3007';
const API_KEY = import.meta.env.VITE_API_KEY || '';

export const authHeaders = (): Record<string, string> =>
  API_KEY ? { 'X-API-Key': API_KEY } : {};

// All fetch calls use credentials: 'include' so the session cookie is sent
export const f = (url: string, init?: RequestInit) =>
  fetch(url, { ...init, credentials: 'include', headers: { ...authHeaders(), ...(init?.headers ?? {}) } });

/** Generic response helper: throws on non-ok, returns parsed JSON. */
export const orgJson = <T>() => async (r: Response): Promise<T> => {
  if (!r.ok) {
    const body = await r.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${r.status}`);
  }
  return r.json();
};
