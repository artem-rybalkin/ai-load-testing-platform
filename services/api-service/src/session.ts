import { createHash } from 'crypto';
import { Pool } from 'pg';

import { TeamRole, SESSION_IDLE_TIMEOUT_MS, SESSION_LAST_SEEN_TOUCH_INTERVAL_MS } from '@alt/shared';

export interface ApiSession {
  projectId: string | null;
  role: TeamRole | null;
}

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Hashes a raw team API key for lookup against team_api_keys.key_hash. */
export const hashApiKey = (key: string): string => createHash('sha256').update(key).digest('hex');

/**
 * DB-backed session lookup mirroring results-service's getSession + role-lookup query —
 * api-service's old HMAC-signed-cookie scheme is incompatible with the opaque session
 * tokens issued by results-service's /auth/login.
 */
export const getApiSession = async (pool: Pool, token: string | undefined): Promise<ApiSession | null> => {
  if (!token) return null;
  const tokenHash = hashToken(token);

  const { rows } = await pool.query<{ user_id: string; team_id: string | null; last_seen_at: Date }>(
    `SELECT user_id, team_id, last_seen_at FROM sessions
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
    [tokenHash]
  );
  if (rows.length === 0) return null;
  const row = rows[0]!; // guarded by rows.length === 0 check above

  // Mirrors results-service's getSession idle-timeout check — same sessions
  // table, both services must agree on what counts as still-active.
  if (Date.now() - row.last_seen_at.getTime() > SESSION_IDLE_TIMEOUT_MS) {
    await pool.query(`UPDATE sessions SET revoked_at = NOW() WHERE token_hash = $1`, [tokenHash]);
    return null;
  }
  if (Date.now() - row.last_seen_at.getTime() > SESSION_LAST_SEEN_TOUCH_INTERVAL_MS) {
    await pool.query(`UPDATE sessions SET last_seen_at = NOW() WHERE token_hash = $1`, [tokenHash]);
  }

  const { user_id: userId, team_id: teamId } = row;
  if (!teamId) return { projectId: null, role: null };

  const { rows: memberRows } = await pool.query<{ role: TeamRole }>(
    `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`,
    [teamId, userId]
  );

  return { projectId: teamId, role: memberRows[0]?.role ?? null };
};
