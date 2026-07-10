/**
 * Workspace CRUD route plugin.
 * Workspaces are named sub-groups within a team for organizing test resources.
 */
import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';

interface WorkspaceRow {
  id: string;
  team_id: string;
  name: string;
  description: string | null;
  created_at: Date;
}

export function workspaceRoutes(app: FastifyInstance, { pool }: { pool: Pool }): void {

  // ── GET /workspaces ───────────────────────────────────────────────────────────

  app.get('/workspaces', async (request, reply) => {
    const projectId = (request as { projectId?: string }).projectId ?? null;
    if (!projectId) return reply.code(403).send({ error: 'Team required' });
    try {
      const { rows } = await pool.query<WorkspaceRow>(
        `SELECT id, team_id, name, description, created_at FROM workspaces WHERE team_id = $1 ORDER BY name ASC`,
        [projectId],
      );
      return { workspaces: rows.map(r => ({ id: r.id, teamId: r.team_id, name: r.name, description: r.description ?? null, createdAt: r.created_at })) };
    } catch {
      return reply.code(500).send({ error: 'Failed to list workspaces' });
    }
  });

  // ── POST /workspaces ──────────────────────────────────────────────────────────

  app.post<{ Body: { name: string; description?: string } }>(
    '/workspaces',
    async (request, reply) => {
      const projectId = (request as { projectId?: string; role?: string }).projectId ?? null;
      const role = (request as { role?: string }).role;
      if (!projectId) return reply.code(403).send({ error: 'Team required' });
      if (role === 'viewer') return reply.code(403).send({ error: 'Viewers cannot create workspaces' });
      const { name, description } = request.body;
      if (!name?.trim()) return reply.code(400).send({ error: 'name is required' });
      try {
        const { rows } = await pool.query<WorkspaceRow>(
          `INSERT INTO workspaces (team_id, name, description) VALUES ($1, $2, $3) RETURNING id, team_id, name, description, created_at`,
          [projectId, name.trim(), description?.trim() ?? null],
        );
        const r = rows[0];
        return reply.code(201).send({ id: r.id, teamId: r.team_id, name: r.name, description: r.description ?? null, createdAt: r.created_at });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === '23505') return reply.code(409).send({ error: 'A workspace with that name already exists' });
        return reply.code(500).send({ error: 'Failed to create workspace' });
      }
    },
  );

  // ── PUT /workspaces/:id ───────────────────────────────────────────────────────

  app.put<{ Params: { id: string }; Body: { name?: string; description?: string } }>(
    '/workspaces/:id',
    async (request, reply) => {
      const projectId = (request as { projectId?: string }).projectId ?? null;
      const role = (request as { role?: string }).role;
      if (!projectId) return reply.code(403).send({ error: 'Team required' });
      if (role === 'viewer') return reply.code(403).send({ error: 'Viewers cannot update workspaces' });
      const { id } = request.params;
      const { name, description } = request.body;
      const sets: string[] = [];
      const vals: unknown[] = [];
      if (name !== undefined) { sets.push(`name = $${vals.length + 1}`); vals.push(name.trim()); }
      if (description !== undefined) { sets.push(`description = $${vals.length + 1}`); vals.push(description?.trim() ?? null); }
      if (!sets.length) return reply.code(400).send({ error: 'Nothing to update' });
      vals.push(id, projectId);
      try {
        const { rows } = await pool.query<WorkspaceRow>(
          `UPDATE workspaces SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND team_id = $${vals.length} RETURNING id, team_id, name, description, created_at`,
          vals,
        );
        if (!rows.length) return reply.code(404).send({ error: 'Workspace not found' });
        const r = rows[0];
        return { id: r.id, teamId: r.team_id, name: r.name, description: r.description ?? null, createdAt: r.created_at };
      } catch (err: unknown) {
        if ((err as { code?: string }).code === '23505') return reply.code(409).send({ error: 'A workspace with that name already exists' });
        return reply.code(500).send({ error: 'Failed to update workspace' });
      }
    },
  );

  // ── DELETE /workspaces/:id ────────────────────────────────────────────────────

  app.delete<{ Params: { id: string } }>(
    '/workspaces/:id',
    async (request, reply) => {
      const projectId = (request as { projectId?: string }).projectId ?? null;
      const role = (request as { role?: string }).role;
      if (!projectId) return reply.code(403).send({ error: 'Team required' });
      if (role !== 'admin') return reply.code(403).send({ error: 'Only admins can delete workspaces' });
      const { id } = request.params;
      try {
        const { rowCount } = await pool.query<WorkspaceRow>(
          `DELETE FROM workspaces WHERE id = $1 AND team_id = $2`,
          [id, projectId],
        );
        if (!rowCount) return reply.code(404).send({ error: 'Workspace not found' });
        return { success: true };
      } catch {
        return reply.code(500).send({ error: 'Failed to delete workspace' });
      }
    },
  );
}
