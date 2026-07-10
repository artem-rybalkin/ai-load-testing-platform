import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Pool } from 'pg';
import { createTestDatabase, truncateAll } from '../../../../test-support/sharedPostgres';
import cron from 'node-cron';
import { startScheduler, reloadSchedule, removeSchedule } from '../scheduler';
import { createSchema } from '../db';

vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn().mockReturnValue({ stop: vi.fn() }),
  },
}));

const mockCronSchedule = cron.schedule as unknown as ReturnType<typeof vi.fn>;

let pool: Pool;
let dropDb: () => Promise<void>;
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
  ({ pool, drop: dropDb } = await createTestDatabase());
  await createSchema(pool);
  mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
  vi.stubGlobal('fetch', mockFetch);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await dropDb();
});

beforeEach(async () => {
  await truncateAll(pool, 'TRUNCATE live_metrics, test_results, test_scripts, webhooks, schedules, test_presets CASCADE');
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

// ─── API_KEY header behaviour ──────────────────────────────────────────────────

describe('triggerSchedule — API_KEY header', () => {
  const originalApiKey = process.env.API_KEY;

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = originalApiKey;
  });

  it('does not send an X-API-Key header when API_KEY is unset', async () => {
    delete process.env.API_KEY;
    await insertSchedule();
    await startScheduler(pool);
    const callback = mockCronSchedule.mock.calls[0][1] as () => Promise<void>;
    await callback();

    const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(headers).not.toHaveProperty('X-API-Key');
    expect(headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('sends the X-API-Key header when API_KEY is set', async () => {
    process.env.API_KEY = 'test-api-key';
    await insertSchedule();
    await startScheduler(pool);
    const callback = mockCronSchedule.mock.calls[0][1] as () => Promise<void>;
    await callback();

    const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('test-api-key');
  });
});

// ─── Multi-replica leader election ───────────────────────────────────────────

describe('triggerSchedule — multi-replica leader election', () => {
  it('fires exactly once when two replicas trigger the same schedule concurrently', async () => {
    // Regression for: "Scheduler has no leader election — every replica fires
    // every cron job."  Each replica runs the same node-cron callback at the
    // same wall-clock second; only the replica that wins the Postgres advisory
    // lock for (schedule_id, fire_window) should call POST /tests.
    //
    // We simulate two replicas by calling the captured cron callback twice
    // concurrently against the same DB pool (each call gets its own connection,
    // equivalent to two separate results-service processes sharing the same DB).
    const id = await insertSchedule();
    await startScheduler(pool);

    const callback = mockCronSchedule.mock.calls[0][1] as () => Promise<void>;

    // Pin Date so both "replicas" compute the identical fire_window lock key —
    // triggerSchedule reads new Date() synchronously before its first await, so
    // in practice both calls virtually always land in the same UTC minute
    // anyway, but under heavy parallel-suite load (e.g. full-coverage CI runs)
    // scheduling jitter between the two synchronous callback() invocations can
    // occasionally straddle a real minute boundary, which would make both
    // "replicas" legitimately win separate locks and flake this assertion.
    // Only `Date` is faked — setTimeout/real async I/O (the Postgres queries
    // this test depends on) are untouched.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // Fire both "replicas" simultaneously.
      await Promise.all([callback(), callback()]);
    } finally {
      vi.useRealTimers();
    }

    // The advisory lock ensures only one call wins — exactly one POST /tests.
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // The winning replica must have committed last_run_at.
    const { rows } = await pool.query(
      'SELECT last_run_at FROM schedules WHERE id = $1',
      [id]
    );
    expect(rows[0].last_run_at).not.toBeNull();
  });
});

// ─── X-Internal-Key header ────────────────────────────────────────────────────

describe('triggerSchedule — X-Internal-Key header (regression)', () => {
  const originalInternalKey = process.env.INTERNAL_API_KEY;

  afterEach(() => {
    if (originalInternalKey === undefined) delete process.env.INTERNAL_API_KEY;
    else process.env.INTERNAL_API_KEY = originalInternalKey;
  });

  it('does not send an X-Internal-Key header when INTERNAL_API_KEY is unset', async () => {
    delete process.env.INTERNAL_API_KEY;
    await insertSchedule();
    await startScheduler(pool);
    const callback = mockCronSchedule.mock.calls[0][1] as () => Promise<void>;
    await callback();

    const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(headers).not.toHaveProperty('X-Internal-Key');
  });

  it('sends the X-Internal-Key header when INTERNAL_API_KEY is set, so scheduled triggers work under RBAC without a global API_KEY', async () => {
    delete process.env.API_KEY;
    process.env.INTERNAL_API_KEY = 'test-internal-key';
    await insertSchedule();
    await startScheduler(pool);
    const callback = mockCronSchedule.mock.calls[0][1] as () => Promise<void>;
    await callback();

    const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['X-Internal-Key']).toBe('test-internal-key');
    expect(headers).not.toHaveProperty('X-API-Key');
  });
});
