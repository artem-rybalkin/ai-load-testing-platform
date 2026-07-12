// The live-metrics chart is meant to show a bounded number of points no
// matter how long a test runs — without this, a multi-hour test (or a
// completed test's full "Test Timeline" view) would return every stored row,
// flooding browser state and Recharts with an ever-growing array. Once a
// test's row count exceeds the cap, uniformly sub-sample instead of
// truncating, so the chart still spans the whole run at a bounded resolution.
export const MAX_LIVE_POINTS = 300;

export function downsampleLivePoints<T>(rows: T[], cap: number = MAX_LIVE_POINTS): T[] {
  if (rows.length <= cap) return rows;
  const stride = Math.ceil(rows.length / cap);
  const sampled = rows.filter((_, i) => i % stride === 0);
  const last = rows[rows.length - 1]!; // rows.length > cap (checked above) implies rows.length >= 1
  if (sampled[sampled.length - 1] !== last) sampled.push(last);
  return sampled;
}
