import { Pool } from 'pg';

/**
 * For each log source (scoped to projectId, or every source when projectId is null —
 * the dev-mode/no-auth convention used throughout this codebase) that has a
 * metrics_endpoint_template configured, interpolate the test timestamps, fetch the
 * external API, and return truncated JSON. Never throws — returns [] on any error
 * so AI analysis is never blocked.
 */
export async function fetchExternalMetrics(
  pool: Pool,
  targetUrl: string,
  startedAt: string | null,
  completedAt: string | null,
  projectId: string | null,
): Promise<Array<{ sourceName: string; platform: string | null; data: string }>> {
  try {
    const { rows } = await pool.query(
      `SELECT name, platform, metrics_endpoint_template, auth_header
       FROM log_sources
       WHERE metrics_endpoint_template IS NOT NULL
         AND ($1::uuid IS NULL OR project_id = $1::uuid)`,
      [projectId]
    );
    if (rows.length === 0) return [];

    const started   = startedAt   ? new Date(startedAt)   : new Date(Date.now() - 3_600_000);
    const completed = completedAt ? new Date(completedAt) : new Date();

    const interpolate = (template: string): string =>
      template
        .replaceAll('{startedAtMs}',      String(started.getTime()))
        .replaceAll('{completedAtMs}',    String(completed.getTime()))
        .replaceAll('{startedAtS}',       String(Math.floor(started.getTime() / 1000)))
        .replaceAll('{completedAtS}',     String(Math.floor(completed.getTime() / 1000)))
        .replaceAll('{startedAtISO}',     started.toISOString())
        .replaceAll('{completedAtISO}',   completed.toISOString())
        .replaceAll('{targetUrl}',        targetUrl)
        .replaceAll('{targetUrlEncoded}', encodeURIComponent(targetUrl));

    const results: Array<{ sourceName: string; platform: string | null; data: string }> = [];

    await Promise.allSettled(
      rows.map(async (row: { name: string; platform: string | null; metrics_endpoint_template: string; auth_header: string | null }) => {
        try {
          const url = interpolate(row.metrics_endpoint_template);
          const headers: Record<string, string> = { 'Accept': 'application/json' };
          if (row.auth_header) headers['Authorization'] = row.auth_header;

          const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
          if (!res.ok) return;
          const text = await res.text();
          results.push({
            sourceName: row.name,
            platform: row.platform,
            data: text.slice(0, 3000), // cap at 3 KB per source
          });
        } catch { /* non-fatal */ }
      })
    );

    return results;
  } catch { return []; }
}
