import { createHash } from 'crypto';
import { Pool } from 'pg';

import { TeamRole } from '@alt/shared';

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

  const { rows } = await pool.query<{ user_id: string; team_id: string | null }>(
    `SELECT user_id, team_id FROM sessions
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
    [hashToken(token)]
  );
  if (rows.length === 0) return null;

  const { user_id: userId, team_id: teamId } = rows[0];
  if (!teamId) return { projectId: null, role: null };

  const { rows: memberRows } = await pool.query<{ role: TeamRole }>(
    `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`,
    [teamId, userId]
  );

  return { projectId: teamId, role: memberRows[0]?.role ?? null };
};
