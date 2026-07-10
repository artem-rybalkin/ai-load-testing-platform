import cron, { ScheduledTask } from 'node-cron';
import { Pool } from 'pg';
import { log } from './logger';

const API_URL = process.env.API_URL || 'http://api-service:3000';

interface Schedule {
  id: string;
  name: string;
  cron: string;
  type: string;
  target_url: string;
  description: string | null;
  options: Record<string, unknown>;
  thresholds: Record<string, unknown> | null;
  enabled: boolean;
  project_id: string | null;
}

const activeTasks = new Map<string, ScheduledTask>();

const triggerSchedule = async (pool: Pool, schedule: Schedule): Promise<void> => {
  // Leader election: only one replica may fire each schedule per cron tick.
  // Every replica's cron task fires at the same wall-clock second; before
  // actually calling POST /tests, each replica attempts a non-blocking
  // Postgres transactional advisory lock keyed on (schedule_id, fire_window)
  // where fire_window is the current UTC minute.
  //
  // pg_try_advisory_xact_lock returns TRUE for the first claimer and FALSE
  // for every subsequent caller while that transaction is still open.  The
  // lock releases automatically when the transaction commits or rolls back —
  // no manual pg_advisory_unlock needed.  This mirrors the pg_advisory_lock
  // convention used in createSchema() in db.ts.
  const fireWindow = new Date().toISOString().slice(0, 16); // "YYYY-MM-DDTHH:MM" UTC
  const lockKey = `${schedule.id}:${fireWindow}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: lockRows } = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtext($1)::bigint) AS acquired`,
      [lockKey]
    );

    if (!lockRows[0].acquired) {
      // Another replica already claimed this firing window — skip silently.
      await client.query('ROLLBACK');
      log.info(
        { scheduleId: schedule.id, fireWindow },
        'Schedule firing skipped — another replica holds the lock'
      );
      return;
    }

    // We hold the lock — proceed with the actual test trigger.
    const apiKey = process.env.API_KEY || '';
    const internalApiKey = process.env.INTERNAL_API_KEY || '';
    const res = await fetch(`${API_URL}/tests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'X-API-Key': apiKey } : {}),
        // Trusted internal channel — works even when no global API_KEY is
        // configured (the documented production setup: Team/RBAC on, no
        // separate global key for service-to-service calls).
        ...(internalApiKey ? { 'X-Internal-Key': internalApiKey } : {}),
      },
      body: JSON.stringify({
        type: schedule.type,
        targetUrl: schedule.target_url,
        description: schedule.description ?? `Scheduled: ${schedule.name}`,
        options: schedule.options,
        thresholds: schedule.thresholds ?? undefined,
        projectId: schedule.project_id ?? undefined,
      }),
    });

    if (!res.ok) throw new Error(`api-service returned ${res.status}`);

    await client.query(
      `UPDATE schedules SET last_run_at = NOW() WHERE id = $1`,
      [schedule.id]
    );
    await client.query('COMMIT');
    log.info({ scheduleId: schedule.id, name: schedule.name }, 'Scheduled test triggered');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore — may already be rolled back */ }
    log.error({ scheduleId: schedule.id, err: (err as Error).message }, 'Failed to trigger scheduled test');
  } finally {
    client.release();
  }
};

const registerSchedule = (pool: Pool, schedule: Schedule): void => {
  if (activeTasks.has(schedule.id)) {
    activeTasks.get(schedule.id)!.stop();
  }
  const task = cron.schedule(schedule.cron, () => triggerSchedule(pool, schedule), {
    name: schedule.id,
    noOverlap: true,
  });
  if (!schedule.enabled) task.stop();
  activeTasks.set(schedule.id, task);
  log.info({ scheduleId: schedule.id, name: schedule.name, cron: schedule.cron }, 'Schedule registered');
};

export const startScheduler = async (pool: Pool): Promise<void> => {
  const { rows } = await pool.query<Schedule>(`SELECT * FROM schedules WHERE enabled = TRUE`);
  for (const schedule of rows) registerSchedule(pool, schedule);
  log.info({ count: rows.length }, 'Scheduler started');
};

export const reloadSchedule = async (pool: Pool, id: string): Promise<void> => {
  const { rows } = await pool.query<Schedule>(`SELECT * FROM schedules WHERE id = $1`, [id]);
  if (rows.length === 0) {
    activeTasks.get(id)?.stop();
    activeTasks.delete(id);
    return;
  }
  registerSchedule(pool, rows[0]);
};

export const removeSchedule = (id: string): void => {
  activeTasks.get(id)?.stop();
  activeTasks.delete(id);
};
