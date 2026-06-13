import { randomBytes, createHash } from 'crypto';
import { Pool } from 'pg';

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

/** Looks up a non-revoked, non-expired session by its raw cookie token. */
export const getSession = async (pool: Pool, token: string | undefined): Promise<SessionRecord | null> => {
  if (!token) return null;
  const { rows } = await pool.query<{ user_id: string; team_id: string | null; expires_at: Date }>(
    `SELECT user_id, team_id, expires_at FROM sessions
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
    [hashToken(token)]
  );
  if (rows.length === 0) return null;
  return { userId: rows[0].user_id, teamId: rows[0].team_id, expiresAt: rows[0].expires_at };
};

/** Marks a session as revoked (logout). */
export const revokeSession = async (pool: Pool, token: string | undefined): Promise<void> => {
  if (!token) return;
  await pool.query(`UPDATE sessions SET revoked_at = NOW() WHERE token_hash = $1`, [hashToken(token)]);
};

/** Updates the "current team" for a session (team switching). */
export const switchSessionTeam = async (pool: Pool, token: string | undefined, teamId: string): Promise<void> => {
  if (!token) return;
  await pool.query(`UPDATE sessions SET team_id = $1 WHERE token_hash = $2`, [teamId, hashToken(token)]);
};
