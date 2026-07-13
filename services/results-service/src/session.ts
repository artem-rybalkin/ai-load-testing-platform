import { randomBytes, createHash } from 'crypto';
import { Pool } from 'pg';
import { SESSION_IDLE_TIMEOUT_MS, SESSION_LAST_SEEN_TOUCH_INTERVAL_MS } from '@alt/shared';

export type TeamRole = 'admin' | 'member' | 'viewer';

export interface SessionRecord {
  userId: string;
  teamId: string | null;
  expiresAt: Date;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Hashes a raw team API key for storage/lookup in team_api_keys.key_hash. */
export const hashApiKey = (key: string): string => createHash('sha256').update(key).digest('hex');

/** Creates a new session for a user, returns the raw token to set in the cookie. */
export const createSession = async (pool: Pool, userId: string, teamId: string | null): Promise<string> => {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query(
    `INSERT INTO sessions (user_id, token_hash, team_id, expires_at) VALUES ($1, $2, $3, $4)`,
    [userId, hashToken(token), teamId, expiresAt]
  );
  return token;
};

/**
 * Looks up a non-revoked, non-expired session by its raw cookie token, also
 * enforcing an idle timeout (SESSION_IDLE_TIMEOUT_MS) independent of the
 * session's 30-day absolute expiry. An idle-timed-out session is revoked on
 * detection rather than silently ignored, so the periodic cleanup sweep
 * (cleanup.ts) picks it up on its next tick same as any other revoked row.
 */
export const getSession = async (pool: Pool, token: string | undefined): Promise<SessionRecord | null> => {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const { rows } = await pool.query<{ user_id: string; team_id: string | null; expires_at: Date; last_seen_at: Date }>(
    `SELECT user_id, team_id, expires_at, last_seen_at FROM sessions
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
    [tokenHash]
  );
  if (rows.length === 0) return null;
  const row = rows[0]!; // guarded by rows.length === 0 above

  if (Date.now() - row.last_seen_at.getTime() > SESSION_IDLE_TIMEOUT_MS) {
    await pool.query(`UPDATE sessions SET revoked_at = NOW() WHERE token_hash = $1`, [tokenHash]);
    return null;
  }
  // Throttled: only write last_seen_at once per SESSION_LAST_SEEN_TOUCH_INTERVAL_MS
  // per session, not on every single request.
  if (Date.now() - row.last_seen_at.getTime() > SESSION_LAST_SEEN_TOUCH_INTERVAL_MS) {
    await pool.query(`UPDATE sessions SET last_seen_at = NOW() WHERE token_hash = $1`, [tokenHash]);
  }

  return { userId: row.user_id, teamId: row.team_id, expiresAt: row.expires_at };
};

/** Marks a session as revoked (logout). */
export const revokeSession = async (pool: Pool, token: string | undefined): Promise<void> => {
  if (!token) return;
  await pool.query(`UPDATE sessions SET revoked_at = NOW() WHERE token_hash = $1`, [hashToken(token)]);
};

/**
 * Rotates the session on team switch: issues a fresh token scoped to the new
 * team and revokes the old one, returning the new raw token to set in the
 * cookie (or undefined for the no-op undefined-token case). Rotating instead
 * of mutating team_id in place means a leaked pre-switch token can't be
 * replayed against the new team's scope (OWASP Session Management Cheat
 * Sheet: regenerate the session ID on any privilege-scope change).
 */
export const switchSessionTeam = async (
  pool: Pool,
  token: string | undefined,
  userId: string,
  teamId: string
): Promise<string | undefined> => {
  if (!token) return undefined;
  const newToken = await createSession(pool, userId, teamId);
  await revokeSession(pool, token);
  return newToken;
};
