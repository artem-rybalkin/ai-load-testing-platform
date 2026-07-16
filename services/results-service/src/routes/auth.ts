/**
 * Auth route plugin: POST /auth/register, /auth/login, /auth/logout,
 * GET /auth/me, POST /auth/switch-team.
 */
import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import { getSessionCookieName, type SessionUser } from '@alt/shared';
import { createSession, revokeSession, switchSessionTeam, getSession } from '../session';
import { loadUserTeams, loadUserOrgs, DEV_USER, EMAIL_RE } from './helpers';

export function authRoutes(app: FastifyInstance, { pool }: { pool: Pool; rPool: Pool }): void {
  const sessionSecret = process.env.SESSION_SECRET || '';
  const AUTH_RATE_LIMIT_MAX = Number(process.env.AUTH_RATE_LIMIT_MAX) || 10;
  // 12 rounds in production — OWASP's stated minimum is 10; 12 gives a margin above
  // the floor rather than sitting exactly on it, at an acceptable hashing-time cost
  // on current hardware (bcryptjs is pure JS, already the slower path). Overridden
  // to a low value in tests (vitest.config.ts) where every registerUser() call would
  // otherwise pay the full ~750ms production cost for no security benefit.
  const AUTH_BCRYPT_ROUNDS = Number(process.env.AUTH_BCRYPT_ROUNDS) || 12;
  const SESSION_COOKIE_NAME = getSessionCookieName();
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
      // bcrypt silently truncates at 72 bytes — OWASP's Password Storage Cheat Sheet
      // warns that two different passwords sharing the same first 72 bytes verify as
      // matching. Reject before that point instead of accepting a password whose
      // effective strength is capped without the user knowing.
      if (Buffer.byteLength(password, 'utf8') > 72) {
        return reply.code(400).send({ error: 'Password must be 72 bytes or fewer' });
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

        const passwordHash = await bcrypt.hash(password, AUTH_BCRYPT_ROUNDS);
        const userResult = await client.query<{ id: string }>(
          'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id',
          [normalizedEmail, passwordHash, name?.trim() || null],
        );
        const userId = userResult.rows[0]!.id; // INSERT ... RETURNING always returns exactly one row

        const normalizedTeamName = teamName.trim().toLowerCase();
        let teamId: string;
        try {
          const teamResult = await client.query<{ id: string }>(
            'INSERT INTO projects (name) VALUES ($1) RETURNING id',
            [normalizedTeamName],
          );
          teamId = teamResult.rows[0]!.id; // INSERT ... RETURNING always returns exactly one row
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
        reply.setCookie(SESSION_COOKIE_NAME, token, cookieOpts);

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
      const userRow = rows[0]!; // guarded by rows.length === 0 above

      const valid = await bcrypt.compare(password, userRow.password_hash);
      if (!valid) return reply.code(401).send({ error: 'Invalid email or password' });

      const teams = await loadUserTeams(pool, userRow.id);
      const currentTeamId = teams.length > 0 ? teams[0]!.id : null;
      const orgs = await loadUserOrgs(pool, userRow.id);

      const token = await createSession(pool, userRow.id, currentTeamId);
      reply.setCookie(SESSION_COOKIE_NAME, token, cookieOpts);

      const result: SessionUser = {
        id: userRow.id,
        email: userRow.email,
        name: userRow.name,
        teams,
        currentTeamId,
        role: currentTeamId ? teams[0]!.role : null,
        orgs,
      };
      return result;
    },
  );

  // ── POST /auth/logout ─────────────────────────────────────────────────────
  app.post('/auth/logout', async (request, reply) => {
    if (sessionSecret) await revokeSession(pool, request.cookies?.[SESSION_COOKIE_NAME]);
    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    return { success: true };
  });

  // ── GET /auth/me ──────────────────────────────────────────────────────────
  app.get('/auth/me', async (request, reply) => {
    if (!sessionSecret) return DEV_USER;

    const session = await getSession(pool, request.cookies?.[SESSION_COOKIE_NAME]);
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

    const row = rows[0]!; // guarded by rows.length === 0 above
    const result: SessionUser = { id: row.id, email: row.email, name: row.name, teams, currentTeamId, role, orgs };
    return result;
  });

  // ── POST /auth/switch-team ────────────────────────────────────────────────
  app.post<{ Body: { teamId: string } }>('/auth/switch-team', async (request, reply) => {
    if (!sessionSecret) return DEV_USER;

    const session = await getSession(pool, request.cookies?.[SESSION_COOKIE_NAME]);
    if (!session) return reply.code(401).send({ error: 'Not authenticated' });

    const { teamId } = request.body ?? {};
    if (!teamId) return reply.code(400).send({ error: 'teamId is required' });

    const teams = await loadUserTeams(pool, session.userId);
    const team = teams.find(t => t.id === teamId);
    if (!team) return reply.code(403).send({ error: 'Not a member of this team' });

    const newToken = await switchSessionTeam(pool, request.cookies?.[SESSION_COOKIE_NAME], session.userId, teamId);
    if (newToken) reply.setCookie(SESSION_COOKIE_NAME, newToken, cookieOpts);

    const { rows } = await pool.query<{ id: string; email: string; name: string | null }>(
      'SELECT id, email, name FROM users WHERE id = $1',
      [session.userId],
    );
    const orgs = await loadUserOrgs(pool, session.userId);

    // session.userId already refers to a real, just-validated user (getSession()
    // above resolved it via the sessions table's FK to users), so this lookup by
    // the same id is guaranteed to find a row.
    const userRow = rows[0]!;
    const result: SessionUser = {
      id: userRow.id,
      email: userRow.email,
      name: userRow.name,
      teams,
      currentTeamId: teamId,
      role: team.role,
      orgs,
    };
    return result;
  });
}
