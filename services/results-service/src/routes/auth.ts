/**
 * Auth route plugin: POST /auth/register, /auth/login, /auth/logout,
 * GET /auth/me, POST /auth/switch-team.
 */
import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import type { SessionUser, TeamRole } from '@alt/shared';
import { createSession, revokeSession, switchSessionTeam, getSession } from '../session';
import { loadUserTeams, loadUserOrgs, DEV_USER, EMAIL_RE } from './helpers';

export async function authRoutes(app: FastifyInstance, { pool }: { pool: Pool; rPool: Pool }): Promise<void> {
  const sessionSecret = process.env.SESSION_SECRET || '';
  const AUTH_RATE_LIMIT_MAX = Number(process.env.AUTH_RATE_LIMIT_MAX) || 10;
  const cookieOpts = {
    httpOnly: true,
    sameSite: 'strict' as const,
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60,
    ...(process.env.DOMAIN ? { domain: `.${process.env.DOMAIN}` } : {}),
  };

  // ── POST /auth/register ───────────────────────────────────────────────────
  app.post<{ Body: { email: string; password: string; name?: string; teamName: string } }>(
    '/auth/register',
    { config: { rateLimit: { max: AUTH_RATE_LIMIT_MAX, timeWindow: 60_000 } } },
    async (request, reply) => {
      if (!sessionSecret) return DEV_USER;

      const { email, password, name, teamName } = request.body ?? {};
      if (!email?.trim() || !EMAIL_RE.test(email.trim())) {
        return reply.code(400).send({ error: 'A valid email is required' });
      }
      if (!password || password.length < 8) {
        return reply.code(400).send({ error: 'Password must be at least 8 characters' });
      }
      if (!teamName?.trim()) {
        return reply.code(400).send({ error: 'teamName is required' });
      }

      const normalizedEmail = email.trim().toLowerCase();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const existing = await client.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
        if (existing.rows.length > 0) {
          await client.query('ROLLBACK');
          return reply.code(409).send({ error: 'Email already registered' });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const userResult = await client.query<{ id: string }>(
          'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id',
          [normalizedEmail, passwordHash, name?.trim() || null],
        );
        const userId = userResult.rows[0].id;

        const normalizedTeamName = teamName.trim().toLowerCase();
        let teamId: string;
        try {
          const teamResult = await client.query<{ id: string }>(
            'INSERT INTO projects (name) VALUES ($1) RETURNING id',
            [normalizedTeamName],
          );
          teamId = teamResult.rows[0].id;
        } catch (err) {
          await client.query('ROLLBACK');
          if ((err as { code?: string }).code === '23505') {
            return reply.code(409).send({ error: 'Team name already taken' });
          }
          throw err;
        }

        await client.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'admin')`, [teamId, userId]);
        await client.query('COMMIT');

        const token = await createSession(pool, userId, teamId);
        reply.setCookie('alt_session', token, cookieOpts);

        const result: SessionUser = {
          id: userId,
          email: normalizedEmail,
          name: name?.trim() || null,
          teams: [{ id: teamId, name: normalizedTeamName, role: 'admin' }],
          currentTeamId: teamId,
          role: 'admin',
          orgs: [],
        };
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  );

  // ── POST /auth/login ──────────────────────────────────────────────────────
  app.post<{ Body: { email: string; password: string } }>(
    '/auth/login',
    { config: { rateLimit: { max: AUTH_RATE_LIMIT_MAX, timeWindow: 60_000 } } },
    async (request, reply) => {
      if (!sessionSecret) return DEV_USER;

      const { email, password } = request.body ?? {};
      if (!email?.trim() || !password) {
        return reply.code(400).send({ error: 'email and password are required' });
      }

      const normalizedEmail = email.trim().toLowerCase();
      const { rows } = await pool.query<{ id: string; email: string; name: string | null; password_hash: string }>(
        'SELECT id, email, name, password_hash FROM users WHERE email = $1',
        [normalizedEmail],
      );
      if (rows.length === 0) return reply.code(401).send({ error: 'Invalid email or password' });

      const valid = await bcrypt.compare(password, rows[0].password_hash);
      if (!valid) return reply.code(401).send({ error: 'Invalid email or password' });

      const teams = await loadUserTeams(pool, rows[0].id);
      const currentTeamId = teams.length > 0 ? teams[0].id : null;
      const orgs = await loadUserOrgs(pool, rows[0].id);

      const token = await createSession(pool, rows[0].id, currentTeamId);
      reply.setCookie('alt_session', token, cookieOpts);

      const result: SessionUser = {
        id: rows[0].id,
        email: rows[0].email,
        name: rows[0].name,
        teams,
        currentTeamId,
        role: currentTeamId ? teams[0].role : null,
        orgs,
      };
      return result;
    },
  );

  // ── POST /auth/logout ─────────────────────────────────────────────────────
  app.post('/auth/logout', async (request, reply) => {
    if (sessionSecret) await revokeSession(pool, request.cookies?.['alt_session']);
    reply.clearCookie('alt_session', { path: '/' });
    return { success: true };
  });

  // ── GET /auth/me ──────────────────────────────────────────────────────────
  app.get('/auth/me', async (request, reply) => {
    if (!sessionSecret) return DEV_USER;

    const session = await getSession(pool, request.cookies?.['alt_session']);
    if (!session) return reply.code(401).send({ error: 'Not authenticated' });

    const { rows } = await pool.query<{ id: string; email: string; name: string | null }>(
      'SELECT id, email, name FROM users WHERE id = $1',
      [session.userId],
    );
    if (rows.length === 0) return reply.code(401).send({ error: 'Not authenticated' });

    const teams = await loadUserTeams(pool, session.userId);
    const currentTeamId = session.teamId;
    const role = currentTeamId ? teams.find(t => t.id === currentTeamId)?.role ?? null : null;
    const orgs = await loadUserOrgs(pool, session.userId);

    const result: SessionUser = { id: rows[0].id, email: rows[0].email, name: rows[0].name, teams, currentTeamId, role, orgs };
    return result;
  });

  // ── POST /auth/switch-team ────────────────────────────────────────────────
  app.post<{ Body: { teamId: string } }>('/auth/switch-team', async (request, reply) => {
    if (!sessionSecret) return DEV_USER;

    const session = await getSession(pool, request.cookies?.['alt_session']);
    if (!session) return reply.code(401).send({ error: 'Not authenticated' });

    const { teamId } = request.body ?? {};
    if (!teamId) return reply.code(400).send({ error: 'teamId is required' });

    const teams = await loadUserTeams(pool, session.userId);
    const team = teams.find(t => t.id === teamId);
    if (!team) return reply.code(403).send({ error: 'Not a member of this team' });

    await switchSessionTeam(pool, request.cookies?.['alt_session'], teamId);

    const { rows } = await pool.query<{ id: string; email: string; name: string | null }>(
      'SELECT id, email, name FROM users WHERE id = $1',
      [session.userId],
    );
    const orgs = await loadUserOrgs(pool, session.userId);

    const result: SessionUser = {
      id: rows[0].id,
      email: rows[0].email,
      name: rows[0].name,
      teams,
      currentTeamId: teamId,
      role: team.role as TeamRole,
      orgs,
    };
    return result;
  });
}
