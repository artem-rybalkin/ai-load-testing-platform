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
  try {
    const apiKey = process.env.API_KEY || '';
    const res = await fetch(`${API_URL}/tests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'X-API-Key': apiKey } : {}),
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

    await pool.query(
      `UPDATE schedules SET last_run_at = NOW() WHERE id = $1`,
      [schedule.id]
    );
    log.info({ scheduleId: schedule.id, name: schedule.name }, 'Scheduled test triggered');
  } catch (err) {
    log.error({ scheduleId: schedule.id, err: (err as Error).message }, 'Failed to trigger scheduled test');
  }
};

const registerSchedule = (pool: Pool, schedule: Schedule): void => {
  if (activeTasks.has(schedule.id)) {
    activeTasks.get(schedule.id)!.stop();
  }
  const task = cron.schedule(schedule.cron, () => triggerSchedule(pool, schedule), {
    name: schedule.id,
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
