/**
 * Teams, orgs, quotas, AI-provider overrides, audit log, data erasure,
 * and per-team API key routes.
 */
import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { randomBytes } from 'crypto';
import type { TeamRole, TeamQuota, OrgRole, AiProviderName } from '@alt/shared';
import { AI_PROVIDER_NAMES } from '@alt/shared';
import { getTeamQuota, upsertTeamQuota, getTeamUsage, getTeamQuotasAndUsageBatch } from '../quotas';
import {
  setTeamAiProviderSetting,
  clearTeamAiProviderSetting,
} from '../settings';
import { recordAudit } from '../audit';
import { removeSchedule } from '../scheduler';
import { hashApiKey } from '../session';

export function teamOrgRoutes(app: FastifyInstance, { pool }: { pool: Pool; rPool: Pool }): void {
  const sessionSecret = process.env.SESSION_SECRET || '';

  // ── Helper: resolve org role for a given user in a given org ─────────────
  const getOrgRole = async (orgId: string, userId: string): Promise<OrgRole | null> => {
    const { rows } = await pool.query<{ role: OrgRole }>(
      'SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2',
      [orgId, userId],
    );
    return rows.length > 0 ? rows[0].role : null;
  };

  // ── POST /teams ───────────────────────────────────────────────────────────
  app.post<{ Body: { name: string } }>('/teams', async (request, reply) => {
    if (!sessionSecret || !request.user) return reply.code(403).send({ error: 'Not available' });

    const { name } = request.body ?? {};
    if (!name?.trim()) return reply.code(400).send({ error: 'name is required' });

    const normalizedName = name.trim().toLowerCase();
    try {
      const { rows } = await pool.query<{ id: string }>('INSERT INTO projects (name) VALUES ($1) RETURNING id', [normalizedName]);
      const teamId = rows[0].id;
      await pool.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'admin')`, [teamId, request.user.id]);
      return { id: teamId, name: normalizedName, role: 'admin' as TeamRole };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return reply.code(409).send({ error: 'Team name already taken' });
      throw err;
    }
  });

  // ── GET /teams/:id/members ────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/teams/:id/members', async (request, reply) => {
    if (!sessionSecret || !request.user) return reply.code(403).send({ error: 'Not available' });
    if (request.params.id !== request.projectId) return reply.code(403).send({ error: 'Not a member of this team' });

    const { rows } = await pool.query<{ userId: string; email: string; name: string | null; role: TeamRole }>(
      `SELECT u.id AS "userId", u.email, u.name, tm.role
       FROM team_members tm JOIN users u ON u.id = tm.user_id
       WHERE tm.team_id = $1 ORDER BY tm.created_at ASC`,
      [request.params.id],
    );
    return rows;
  });

  // ── POST /teams/:id/members ───────────────────────────────────────────────
  app.post<{ Params: { id: string }; Body: { email: string; role?: TeamRole } }>('/teams/:id/members', async (request, reply) => {
    if (request.params.id !== request.projectId) return reply.code(403).send({ error: 'Not a member of this team' });

    const { email, role } = request.body ?? {};
    if (!email?.trim()) return reply.code(400).send({ error: 'email is required' });
    const memberRole: TeamRole = role && ['admin', 'member', 'viewer'].includes(role) ? role : 'member';

    const { rows: userRows } = await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email.trim().toLowerCase()]);
    if (userRows.length === 0) return reply.code(404).send({ error: 'No user with that email' });

    try {
      await pool.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)`, [request.params.id, userRows[0].id, memberRole]);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return reply.code(409).send({ error: 'User is already a member of this team' });
      throw err;
    }
    return { success: true };
  });

  // ── PUT /teams/:id/members/:userId ────────────────────────────────────────
  app.put<{ Params: { id: string; userId: string }; Body: { role: TeamRole } }>('/teams/:id/members/:userId', async (request, reply) => {
    if (request.params.id !== request.projectId) return reply.code(403).send({ error: 'Not a member of this team' });

    const { role } = request.body ?? {};
    if (!role || !['admin', 'member', 'viewer'].includes(role)) return reply.code(400).send({ error: 'role must be admin, member, or viewer' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT 1 FROM team_members WHERE team_id = $1 FOR UPDATE`, [request.params.id]);

      if (role !== 'admin') {
        const { rows } = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM team_members WHERE team_id = $1 AND role = 'admin' AND user_id != $2`,
          [request.params.id, request.params.userId],
        );
        if (parseInt(rows[0].count, 10) === 0) {
          await client.query('ROLLBACK');
          return reply.code(409).send({ error: 'Cannot remove the last admin' });
        }
      }

      const { rowCount } = await client.query(
        `UPDATE team_members SET role = $1 WHERE team_id = $2 AND user_id = $3`,
        [role, request.params.id, request.params.userId],
      );
      if (!rowCount) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'Member not found' });
      }
      await client.query('COMMIT');
      return { success: true };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  // ── DELETE /teams/:id/members/:userId ─────────────────────────────────────
  app.delete<{ Params: { id: string; userId: string } }>('/teams/:id/members/:userId', async (request, reply) => {
    if (request.params.id !== request.projectId) return reply.code(403).send({ error: 'Not a member of this team' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT 1 FROM team_members WHERE team_id = $1 FOR UPDATE`, [request.params.id]);

      const { rows } = await client.query<{ role: TeamRole }>(
        `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`,
        [request.params.id, request.params.userId],
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'Member not found' });
      }

      if (rows[0].role === 'admin') {
        const { rows: adminRows } = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM team_members WHERE team_id = $1 AND role = 'admin' AND user_id != $2`,
          [request.params.id, request.params.userId],
        );
        if (parseInt(adminRows[0].count, 10) === 0) {
          await client.query('ROLLBACK');
          return reply.code(409).send({ error: 'Cannot remove the last admin' });
        }
      }

      await client.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [request.params.id, request.params.userId]);
      await client.query('COMMIT');
      return { success: true };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  // ── GET /teams/:id/quotas ─────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/teams/:id/quotas', async (request, reply) => {
    if (!sessionSecret || !request.user) return reply.code(403).send({ error: 'Not available' });
    if (request.params.id !== request.projectId) return reply.code(403).send({ error: 'Not a member of this team' });

    const [quota, usage] = await Promise.all([
      getTeamQuota(pool, request.params.id),
      getTeamUsage(pool, request.params.id),
    ]);
    return { quota, usage };
  });

  // ── PUT /teams/:id/quotas ─────────────────────────────────────────────────
  app.put<{ Params: { id: string }; Body: Partial<TeamQuota> }>('/teams/:id/quotas', async (request, reply) => {
    if (request.params.id !== request.projectId) return reply.code(403).send({ error: 'Not a member of this team' });

    const updates = request.body ?? {};
    const allowedKeys: (keyof TeamQuota)[] = [
      'maxConcurrentTests', 'maxVusPerTest', 'maxTestDurationSeconds', 'maxScheduledTests', 'maxGeminiCallsPerDay',
    ];
    const sanitized: Partial<TeamQuota> = {};
    for (const key of Object.keys(updates) as (keyof TeamQuota)[]) {
      if (!allowedKeys.includes(key)) continue;
      const value = updates[key];
      if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        return reply.code(400).send({ error: `${key} must be a positive integer` });
      }
      sanitized[key] = value;
    }
    if (Object.keys(sanitized).length === 0) return reply.code(400).send({ error: 'No valid quota fields provided' });

    const quota = await upsertTeamQuota(pool, request.params.id, sanitized);
    return { quota };
  });

  // ── PUT /teams/:id/ai-provider ────────────────────────────────────────────
  app.put<{ Params: { id: string }; Body: { provider: AiProviderName; fallbacks?: AiProviderName[] } }>(
    '/teams/:id/ai-provider',
    async (request, reply) => {
      if (request.params.id !== request.projectId) return reply.code(403).send({ error: 'Not a member of this team' });
      if (request.role !== 'admin') return reply.code(403).send({ error: 'Admin role required' });

      const { provider, fallbacks } = request.body ?? {};
      if (!AI_PROVIDER_NAMES.includes(provider)) {
        return reply.code(400).send({ error: `provider must be one of: ${AI_PROVIDER_NAMES.join(', ')}` });
      }
      const cleanFallbacks = (fallbacks ?? []).filter(f => AI_PROVIDER_NAMES.includes(f) && f !== provider);
      const setting = { provider, fallbacks: cleanFallbacks };
      await setTeamAiProviderSetting(pool, request.params.id, setting);
      return { ...setting, isOverride: true };
    },
  );

  // ── DELETE /teams/:id/ai-provider ─────────────────────────────────────────
  app.delete<{ Params: { id: string } }>('/teams/:id/ai-provider', async (request, reply) => {
    if (request.params.id !== request.projectId) return reply.code(403).send({ error: 'Not a member of this team' });
    if (request.role !== 'admin') return reply.code(403).send({ error: 'Admin role required' });

    await clearTeamAiProviderSetting(pool, request.params.id);
    return { success: true };
  });

  // ── GET /teams/:id/audit-log ──────────────────────────────────────────────
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/teams/:id/audit-log', async (request, reply) => {
    if (!sessionSecret || !request.user) return reply.code(403).send({ error: 'Not available' });
    if (request.params.id !== request.projectId) return reply.code(403).send({ error: 'Not a member of this team' });
    if (request.role !== 'admin') return reply.code(403).send({ error: 'Admin role required' });

    const limit = Math.min(Math.max(parseInt(request.query.limit ?? '100', 10) || 100, 1), 500);
    const { rows } = await pool.query(
      `SELECT a.id, a.action, a.resource_type AS "resourceType", a.resource_id AS "resourceId",
              a.created_at AS "createdAt", u.email AS "userEmail"
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.team_id = $1
       ORDER BY a.created_at DESC
       LIMIT $2`,
      [request.params.id, limit],
    );
    return { entries: rows };
  });

  // ── DELETE /teams/:id/data ────────────────────────────────────────────────
  app.delete<{ Params: { id: string }; Body: { confirm?: boolean } }>('/teams/:id/data', async (request, reply) => {
    if (!sessionSecret || !request.user) return reply.code(403).send({ error: 'Not available' });
    if (request.params.id !== request.projectId) return reply.code(403).send({ error: 'Not a member of this team' });
    if (request.role !== 'admin') return reply.code(403).send({ error: 'Admin role required' });
    if (request.body?.confirm !== true) return reply.code(400).send({ error: 'Must confirm: { "confirm": true }' });

    const teamId = request.params.id;

    const { rows: schedules } = await pool.query<{ id: string }>(
      'SELECT id FROM schedules WHERE project_id = $1', [teamId],
    );

    await pool.query(
      `DELETE FROM live_metrics WHERE test_id IN (SELECT test_id FROM test_results WHERE project_id = $1)`,
      [teamId],
    );
    const { rowCount: testResultsDeleted } = await pool.query('DELETE FROM test_results WHERE project_id = $1', [teamId]);
    const { rowCount: scriptsDeleted } = await pool.query('DELETE FROM test_scripts WHERE project_id = $1', [teamId]);
    await pool.query('DELETE FROM schedules WHERE project_id = $1', [teamId]);
    await pool.query('DELETE FROM test_presets WHERE project_id = $1', [teamId]);
    await pool.query('DELETE FROM webhooks WHERE project_id = $1', [teamId]);
    await pool.query('DELETE FROM log_sources WHERE project_id = $1', [teamId]);
    await pool.query('DELETE FROM audit_log WHERE team_id = $1', [teamId]);

    for (const s of schedules) removeSchedule(s.id);

    await recordAudit(pool, { teamId, userId: request.user.id, action: 'erase_team_data', resourceType: 'team_data', resourceId: teamId });

    return {
      success: true,
      deleted: {
        testResults: testResultsDeleted ?? 0,
        scripts: scriptsDeleted ?? 0,
        schedules: schedules.length,
      },
    };
  });

  // ── POST /orgs ────────────────────────────────────────────────────────────
  app.post<{ Body: { name: string } }>('/orgs', async (request, reply) => {
    if (!sessionSecret || !request.user) return reply.code(403).send({ error: 'Not available' });

    const { name } = request.body ?? {};
    if (!name?.trim()) return reply.code(400).send({ error: 'name is required' });

    const normalizedName = name.trim().toLowerCase();
    try {
      const { rows } = await pool.query<{ id: string }>('INSERT INTO organizations (name) VALUES ($1) RETURNING id', [normalizedName]);
      const orgId = rows[0].id;
      await pool.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`, [orgId, request.user.id]);
      return { id: orgId, name: normalizedName, role: 'owner' as OrgRole };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return reply.code(409).send({ error: 'Organization name already taken' });
      throw err;
    }
  });

  // ── GET /orgs/:id ─────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/orgs/:id', async (request, reply) => {
    if (!sessionSecret || !request.user) return reply.code(403).send({ error: 'Not available' });

    const role = await getOrgRole(request.params.id, request.user.id);
    if (!role) return reply.code(403).send({ error: 'Not a member of this organization' });

    const { rows: orgRows } = await pool.query<{ id: string; name: string; createdAt: string }>(
      'SELECT id, name, created_at AS "createdAt" FROM organizations WHERE id = $1',
      [request.params.id],
    );
    if (orgRows.length === 0) return reply.code(404).send({ error: 'Organization not found' });

    const { rows: members } = await pool.query<{ userId: string; email: string; name: string | null; role: OrgRole }>(
      `SELECT u.id AS "userId", u.email, u.name, om.role
       FROM org_members om JOIN users u ON u.id = om.user_id
       WHERE om.org_id = $1 ORDER BY om.created_at ASC`,
      [request.params.id],
    );

    const { rows: teamRows } = await pool.query<{ id: string; name: string }>(
      'SELECT id, name FROM projects WHERE org_id = $1 ORDER BY created_at ASC',
      [request.params.id],
    );
    const quotaUsageByTeam = await getTeamQuotasAndUsageBatch(pool, teamRows.map(t => t.id));
    const teams = teamRows.map(t => ({
      id: t.id,
      name: t.name,
      quota: quotaUsageByTeam.get(t.id)!.quota,
      usage: quotaUsageByTeam.get(t.id)!.usage,
    }));

    return { org: orgRows[0], members, teams, role };
  });

  // ── POST /orgs/:id/members ────────────────────────────────────────────────
  app.post<{ Params: { id: string }; Body: { email: string; role?: OrgRole } }>('/orgs/:id/members', async (request, reply) => {
    if (!sessionSecret || !request.user) return reply.code(403).send({ error: 'Not available' });

    const callerRole = await getOrgRole(request.params.id, request.user.id);
    if (callerRole !== 'owner' && callerRole !== 'admin') return reply.code(403).send({ error: 'Org owner or admin role required' });

    const { email, role: newRole } = request.body ?? {};
    if (!email?.trim()) return reply.code(400).send({ error: 'email is required' });
    const memberRole: OrgRole = newRole && ['owner', 'admin', 'member'].includes(newRole) ? newRole : 'member';

    const { rows: userRows } = await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email.trim().toLowerCase()]);
    if (userRows.length === 0) return reply.code(404).send({ error: 'No user with that email' });

    try {
      await pool.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)`, [request.params.id, userRows[0].id, memberRole]);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return reply.code(409).send({ error: 'User is already a member of this organization' });
      throw err;
    }
    return { success: true };
  });

  // ── PUT /orgs/:id/members/:userId ─────────────────────────────────────────
  app.put<{ Params: { id: string; userId: string }; Body: { role: OrgRole } }>('/orgs/:id/members/:userId', async (request, reply) => {
    if (!sessionSecret || !request.user) return reply.code(403).send({ error: 'Not available' });

    const callerRole = await getOrgRole(request.params.id, request.user.id);
    if (callerRole !== 'owner' && callerRole !== 'admin') return reply.code(403).send({ error: 'Org owner or admin role required' });

    const { role } = request.body ?? {};
    if (!role || !['owner', 'admin', 'member'].includes(role)) return reply.code(400).send({ error: 'role must be owner, admin, or member' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT 1 FROM org_members WHERE org_id = $1 FOR UPDATE`, [request.params.id]);

      if (role !== 'owner') {
        const { rows } = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM org_members WHERE org_id = $1 AND role = 'owner' AND user_id != $2`,
          [request.params.id, request.params.userId],
        );
        if (parseInt(rows[0].count, 10) === 0) {
          await client.query('ROLLBACK');
          return reply.code(409).send({ error: 'Cannot remove the last owner' });
        }
      }

      const { rowCount } = await client.query(
        `UPDATE org_members SET role = $1 WHERE org_id = $2 AND user_id = $3`,
        [role, request.params.id, request.params.userId],
      );
      if (!rowCount) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'Member not found' });
      }
      await client.query('COMMIT');
      return { success: true };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  // ── DELETE /orgs/:id/members/:userId ──────────────────────────────────────
  app.delete<{ Params: { id: string; userId: string } }>('/orgs/:id/members/:userId', async (request, reply) => {
    if (!sessionSecret || !request.user) return reply.code(403).send({ error: 'Not available' });

    const callerRole = await getOrgRole(request.params.id, request.user.id);
    if (callerRole !== 'owner' && callerRole !== 'admin') return reply.code(403).send({ error: 'Org owner or admin role required' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT 1 FROM org_members WHERE org_id = $1 FOR UPDATE`, [request.params.id]);

      const { rows } = await client.query<{ role: OrgRole }>(
        `SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2`,
        [request.params.id, request.params.userId],
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'Member not found' });
      }

      if (rows[0].role === 'owner') {
        const { rows: ownerRows } = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM org_members WHERE org_id = $1 AND role = 'owner' AND user_id != $2`,
          [request.params.id, request.params.userId],
        );
        if (parseInt(ownerRows[0].count, 10) === 0) {
          await client.query('ROLLBACK');
          return reply.code(409).send({ error: 'Cannot remove the last owner' });
        }
      }

      await client.query(`DELETE FROM org_members WHERE org_id = $1 AND user_id = $2`, [request.params.id, request.params.userId]);
      await client.query('COMMIT');
      return { success: true };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  // ── POST /orgs/:id/teams ──────────────────────────────────────────────────
  app.post<{ Params: { id: string }; Body: { name: string } }>('/orgs/:id/teams', async (request, reply) => {
    if (!sessionSecret || !request.user) return reply.code(403).send({ error: 'Not available' });

    const callerRole = await getOrgRole(request.params.id, request.user.id);
    if (callerRole !== 'owner' && callerRole !== 'admin') return reply.code(403).send({ error: 'Org owner or admin role required' });

    const { name } = request.body ?? {};
    if (!name?.trim()) return reply.code(400).send({ error: 'name is required' });

    const normalizedName = name.trim().toLowerCase();
    try {
      const { rows } = await pool.query<{ id: string }>(
        'INSERT INTO projects (name, org_id) VALUES ($1, $2) RETURNING id',
        [normalizedName, request.params.id],
      );
      const teamId = rows[0].id;
      await pool.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'admin')`, [teamId, request.user.id]);
      return { id: teamId, name: normalizedName, role: 'admin' as TeamRole };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return reply.code(409).send({ error: 'Team name already taken' });
      throw err;
    }
  });

  // ── POST /teams/:id/api-keys ──────────────────────────────────────────────
  app.post<{ Params: { id: string }; Body: { name: string } }>('/teams/:id/api-keys', async (request, reply) => {
    if (request.params.id !== request.projectId) return reply.code(403).send({ error: 'Not a member of this team' });

    const { name } = request.body ?? {};
    if (!name?.trim()) return reply.code(400).send({ error: 'name is required' });

    const rawKey = randomBytes(24).toString('hex');
    const { rows } = await pool.query<{ id: string; createdAt: string }>(
      `INSERT INTO team_api_keys (team_id, name, key_hash) VALUES ($1, $2, $3) RETURNING id, created_at AS "createdAt"`,
      [request.params.id, name.trim(), hashApiKey(rawKey)],
    );
    return { id: rows[0].id, name: name.trim(), key: rawKey, createdAt: rows[0].createdAt };
  });

  // ── GET /teams/:id/api-keys ───────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/teams/:id/api-keys', async (request, reply) => {
    if (!sessionSecret || !request.user) return reply.code(403).send({ error: 'Not available' });
    if (request.params.id !== request.projectId) return reply.code(403).send({ error: 'Not a member of this team' });
    if (request.role !== 'admin') return reply.code(403).send({ error: 'Admin role required' });

    const { rows } = await pool.query<{ id: string; name: string; createdAt: string; lastUsedAt: string | null; revoked: boolean }>(
      `SELECT id, name, created_at AS "createdAt", last_used_at AS "lastUsedAt", (revoked_at IS NOT NULL) AS revoked
       FROM team_api_keys WHERE team_id = $1 ORDER BY created_at ASC`,
      [request.params.id],
    );
    return rows;
  });

  // ── DELETE /teams/:id/api-keys/:keyId ─────────────────────────────────────
  app.delete<{ Params: { id: string; keyId: string } }>('/teams/:id/api-keys/:keyId', async (request, reply) => {
    if (request.params.id !== request.projectId) return reply.code(403).send({ error: 'Not a member of this team' });

    const { rowCount } = await pool.query(
      `UPDATE team_api_keys SET revoked_at = NOW() WHERE id = $1 AND team_id = $2 AND revoked_at IS NULL`,
      [request.params.keyId, request.params.id],
    );
    if (!rowCount) return reply.code(404).send({ error: 'API key not found' });
    return { success: true };
  });
}
