import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import cron from 'node-cron';
import { startScheduler, reloadSchedule, removeSchedule } from '../scheduler';
import { createSchema } from '../db';

vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn().mockReturnValue({ stop: vi.fn() }),
  },
}));

const mockCronSchedule = cron.schedule as unknown as ReturnType<typeof vi.fn>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let mockFetch: ReturnType<typeof vi.fn>;

const insertSchedule = async (enabled = true): Promise<string> => {
  const { rows } = await pool.query(
    `INSERT INTO schedules (name, cron, type, target_url, options, enabled)
     VALUES ('Test schedule', '* * * * *', 'backend', 'http://example.com',
             '{"vus":5,"duration":"30s"}', $1)
     RETURNING id`,
    [enabled]
  );
  return rows[0].id as string;
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await createSchema(pool);
  mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
  vi.stubGlobal('fetch', mockFetch);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query('TRUNCATE live_metrics, test_results, test_scripts, webhooks, schedules, test_templates CASCADE');
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
  mockCronSchedule.mockClear();
  mockCronSchedule.mockReturnValue({ stop: vi.fn() });
});

// ─── startScheduler ───────────────────────────────────────────────────────────

describe('startScheduler', () => {
  it('registers only enabled schedules with node-cron', async () => {
    await insertSchedule(true);
    await insertSchedule(true);
    await insertSchedule(false);
    await startScheduler(pool);
    expect(mockCronSchedule).toHaveBeenCalledTimes(2);
  });

  it('passes the correct cron expression to cron.schedule', async () => {
    await pool.query(
      `INSERT INTO schedules (name, cron, type, target_url, options, enabled)
       VALUES ('Custom cron', '0 * * * *', 'backend', 'http://example.com', '{"vus":1,"duration":"10s"}', TRUE)`
    );
    await startScheduler(pool);
    expect(mockCronSchedule).toHaveBeenCalledWith('0 * * * *', expect.any(Function), expect.any(Object));
  });

  it('does nothing when no enabled schedules exist', async () => {
    await startScheduler(pool);
    expect(mockCronSchedule).not.toHaveBeenCalled();
  });
});

// ─── removeSchedule ───────────────────────────────────────────────────────────

describe('removeSchedule', () => {
  it('calls stop() on the underlying cron task', async () => {
    const mockStop = vi.fn();
    mockCronSchedule.mockReturnValueOnce({ stop: mockStop });
    const id = await insertSchedule();
    await startScheduler(pool);
    removeSchedule(id);
    expect(mockStop).toHaveBeenCalled();
  });

  it('is a no-op when the id is not registered', () => {
    expect(() => removeSchedule('00000000-0000-0000-0000-000000000099')).not.toThrow();
  });
});

// ─── reloadSchedule ───────────────────────────────────────────────────────────

describe('reloadSchedule', () => {
  it('re-registers the schedule and creates a new cron task', async () => {
    const id = await insertSchedule();
    await startScheduler(pool);
    mockCronSchedule.mockClear();
    await reloadSchedule(pool, id);
    expect(mockCronSchedule).toHaveBeenCalledTimes(1);
  });

  it('stops the old cron task when re-registering', async () => {
    const oldStop = vi.fn();
    mockCronSchedule.mockReturnValueOnce({ stop: oldStop });
    const id = await insertSchedule();
    await startScheduler(pool);
    await reloadSchedule(pool, id);
    expect(oldStop).toHaveBeenCalled();
  });

  it('stops and removes the task when the schedule no longer exists in DB', async () => {
    const mockStop = vi.fn();
    mockCronSchedule.mockReturnValueOnce({ stop: mockStop });
    const id = await insertSchedule();
    await startScheduler(pool);
    await pool.query('DELETE FROM schedules WHERE id = $1', [id]);
    await reloadSchedule(pool, id);
    expect(mockStop).toHaveBeenCalled();
    // Second call should not re-register (no row in DB)
    mockCronSchedule.mockClear();
    expect(mockCronSchedule).not.toHaveBeenCalled();
  });
});

// ─── triggerSchedule (via the cron callback) ──────────────────────────────────

describe('triggerSchedule — via captured cron callback', () => {
  it('calls POST /tests on api-service with the schedule body', async () => {
    await insertSchedule();
    await startScheduler(pool);
    const callback = mockCronSchedule.mock.calls[0][1] as () => Promise<void>;
    await callback();
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/tests'),
      expect.objectContaining({ method: 'POST' })
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.type).toBe('backend');
    expect(body.targetUrl).toBe('http://example.com');
    expect(body.options).toMatchObject({ vus: 5, duration: '30s' });
  });

  it('updates last_run_at in DB after a successful trigger', async () => {
    const id = await insertSchedule();
    await startScheduler(pool);
    const callback = mockCronSchedule.mock.calls[0][1] as () => Promise<void>;
    await callback();
    const { rows } = await pool.query('SELECT last_run_at FROM schedules WHERE id = $1', [id]);
    expect(rows[0].last_run_at).not.toBeNull();
  });

  it('does not update last_run_at when the api-service returns an error', async () => {
    const id = await insertSchedule();
    await startScheduler(pool);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const callback = mockCronSchedule.mock.calls[0][1] as () => Promise<void>;
    await callback();
    const { rows } = await pool.query('SELECT last_run_at FROM schedules WHERE id = $1', [id]);
    expect(rows[0].last_run_at).toBeNull();
  });

  it('uses a default description when schedule description is null', async () => {
    await insertSchedule();
    await startScheduler(pool);
    const callback = mockCronSchedule.mock.calls[0][1] as () => Promise<void>;
    await callback();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.description).toContain('Scheduled');
    expect(typeof body.description).toBe('string');
  });
});
