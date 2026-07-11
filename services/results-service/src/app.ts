import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { Pool } from 'pg';
import { setupWebSocketServer } from './ws';
import { getSession, hashApiKey } from './session';
import { getRateLimitMax } from './settings';
import { redisClient } from './redis';
import type { TeamRole, OrgRole } from '@alt/shared';
import { authRoutes } from './routes/auth';
import { teamOrgRoutes } from './routes/teams';
import { systemRoutes } from './routes/system';
import { resultRoutes } from './routes/results';
import { aiRoutes } from './routes/ai';
import { resourceRoutes } from './routes/resources';
import { workspaceRoutes } from './routes/workspaces';

// Augment Fastify request type with session info — must be at module level
declare module 'fastify' {
  interface FastifyRequest {
    user: { id: string; email: string; name: string | null } | null;
    projectId: string | undefined;
    role: TeamRole | null;
    orgId: string | null;
    orgRole: OrgRole | null;
  }
}

export { fetchExternalMetrics } from './externalMetrics';
export { buildChatParsePrompt, MULTI_STEP_INTENT_RE } from './routes/helpers';

export const buildApp = async (
  pool: Pool,
  opts: { logger?: boolean; readPool?: Pool } = {}
): Promise<FastifyInstance> => {
  const rPool = opts.readPool ?? pool;
  const app = Fastify({ logger: opts.logger ?? false });

  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  // Do not send credentials header when origin is wildcard — browsers reject
  // the wildcard+credentials combination (CORS spec §3.2.5), and omitting
  // credentials: true when origin is '*' removes the misconfiguration risk.
  await app.register(cors, { origin: allowedOrigin, credentials: allowedOrigin !== '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] });
  await app.register(cookie);

  // Attach WebSocket server to Fastify's underlying http.Server.
  // Handles GET /ws upgrade without any Fastify plugin — works with Fastify v5.
  setupWebSocketServer(app.server);

  const sessionSecret = process.env.SESSION_SECRET || '';
  const apiKeys = (process.env.API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
  const internalApiKey = process.env.INTERNAL_API_KEY || '';

  // Endpoints that bypass all HTTP auth entirely (health checks, UI websocket)
  const publicPaths = new Set(['/health', '/ws']);

  // Server-to-server callbacks from api-service/workers/ai-service (no cookie).
  // Gated by INTERNAL_API_KEY (X-Internal-Key header) when configured; empty =
  // disabled, same convention as API_KEYS, for local dev.
  const internalPaths = new Set(['/results/pending', '/internal/gemini-usage']);
  const internalSuffixes = ['/running', '/fail', '/message', '/live', '/cancel', '/log-line'];
  const isInternalCallback = (url: string, method: string): boolean => {
    if (internalPaths.has(url)) return true;
    // GET /results/:testId/live is read by the UI and must be project-scoped;
    // only the worker's POST (pushing live metric points) is server-to-server.
    if (url.endsWith('/live') && method === 'GET') return false;
    return internalSuffixes.some(s => url.endsWith(s));
  };
  const isInternal = (url: string, method: string): boolean => publicPaths.has(url) || isInternalCallback(url, method);

  // Cached (not re-queried per request) and scoped to this app instance —
  // admin-configurable via the Settings page (falls back to RATE_LIMIT_MAX
  // env var, then a hardcoded default; see settings.ts).
  let cachedRateLimitMax: { value: number; at: number } | null = null;
  const RATE_LIMIT_CACHE_MS = 30_000;
  await app.register(rateLimit, {
    global: true,
    max: async () => {
      if (cachedRateLimitMax && Date.now() - cachedRateLimitMax.at < RATE_LIMIT_CACHE_MS) return cachedRateLimitMax.value;
      const value = await getRateLimitMax(pool);
      cachedRateLimitMax = { value, at: Date.now() };
      return value;
    },
    timeWindow: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
    redis: redisClient,
    skipOnError: true,
    allowList: (request) => isInternal(request.url.split('?')[0], request.method),
  });

  app.addHook('onRequest', async (request, reply) => {
    const url = request.url.split('?')[0];
    if (url.startsWith('/auth/')) return;
    if (publicPaths.has(url)) return;
    // GET is read by ai-service (no session) to pick the active provider; PUT
    // still requires normal session/admin auth (handled below + in the handler).
    if (url === '/system/ai-provider' && request.method === 'GET') return;
    // GET is read by worker-backend (no session) at test-dequeue time to pick the
    // live-metrics window; PUT still requires normal session/admin auth.
    if (url === '/system/live-metric-window' && request.method === 'GET') return;

    if (isInternalCallback(url, request.method)) {
      if (internalApiKey && request.headers['x-internal-key'] !== internalApiKey) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      return;
    }

    const apiKeyHeader = request.headers['x-api-key'] as string | undefined;

    // Per-team API key — scopes the request to one team regardless of global
    // API_KEYS / session config. Checked first since it's the most specific.
    if (apiKeyHeader && !apiKeys.includes(apiKeyHeader)) {
      const keyHash = hashApiKey(apiKeyHeader);
      try {
        const { rows } = await pool.query<{ team_id: string }>(
          `SELECT team_id FROM team_api_keys WHERE key_hash = $1 AND revoked_at IS NULL`,
          [keyHash]
        );
        if (rows.length > 0) {
          pool.query(`UPDATE team_api_keys SET last_used_at = NOW() WHERE key_hash = $1`, [keyHash]).catch(() => {});
          request.user = null;
          request.projectId = rows[0].team_id;
          request.role = 'admin';
          request.orgId = null;
          request.orgRole = null;
          return;
        }
      } catch {
        // team_api_keys lookup unavailable — fall through to global API key / session checks
      }
    }

    // API key auth (existing, kept for backward compat)
    if (apiKeys.length > 0) {
      if (!apiKeyHeader || !apiKeys.includes(apiKeyHeader)) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
    }

    // Session auth — only enforced when SESSION_SECRET is configured
    if (sessionSecret) {
      const session = await getSession(pool, request.cookies['alt_session']);
      if (!session) return reply.code(401).send({ error: 'Not authenticated' });

      const { rows } = await pool.query<{ id: string; email: string; name: string | null; role: TeamRole | null }>(
        `SELECT u.id, u.email, u.name, tm.role
         FROM users u
         LEFT JOIN team_members tm ON tm.user_id = u.id AND tm.team_id = $2
         WHERE u.id = $1`,
        [session.userId, session.teamId]
      );
      if (rows.length === 0) return reply.code(401).send({ error: 'Not authenticated' });

      request.user = { id: rows[0].id, email: rows[0].email, name: rows[0].name };
      request.projectId = session.teamId ?? undefined;
      request.role = rows[0].role;
      request.orgId = null;
      request.orgRole = null;

      // A session with no current team (or no longer a member of it) has no
      // access to project-scoped resources — except /teams and /orgs, where it
      // can create/join a new team or org.
      if (request.role === null && !url.startsWith('/teams') && !url.startsWith('/orgs')) {
        return reply.code(403).send({ error: 'No team selected — create or join a team first' });
      }

      // Resolve the org owning the current team (if any) and the caller's role in it.
      if (request.projectId) {
        const { rows: orgRows } = await pool.query<{ orgId: string; role: OrgRole }>(
          `SELECT p.org_id AS "orgId", om.role
           FROM projects p
           JOIN org_members om ON om.org_id = p.org_id AND om.user_id = $1
           WHERE p.id = $2`,
          [session.userId, request.projectId]
        );
        if (orgRows.length > 0) {
          request.orgId = orgRows[0].orgId;
          request.orgRole = orgRows[0].role;
        }
      }

      // /orgs/:id/* handlers resolve org membership/role for :id directly
      // (request.orgRole reflects the *current team's* org, which may differ).
      const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method);
      if (isMutation) {
        if (/^\/teams\/[^/]+/.test(url)) {
          if (request.role !== 'admin') return reply.code(403).send({ error: 'Admin role required' });
        } else if (url !== '/teams' && url !== '/orgs' && !url.startsWith('/orgs/') && request.role === 'viewer') {
          return reply.code(403).send({ error: 'Viewer role cannot perform this action' });
        }
      }
    } else {
      request.user = null;
      request.projectId = undefined;
      request.role = null;
      request.orgId = null;
      request.orgRole = null;
    }
  });

  await app.register(authRoutes, { pool, rPool });
  await app.register(teamOrgRoutes, { pool, rPool });
  await app.register(systemRoutes, { pool, rPool });
  await app.register(resultRoutes, { pool, rPool });
  await app.register(aiRoutes, { pool, rPool });
  await app.register(resourceRoutes, { pool, rPool });
  await app.register(workspaceRoutes, { pool });

  return app;
};
