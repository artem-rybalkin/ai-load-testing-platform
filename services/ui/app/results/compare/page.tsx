import { useLoaderData, Link, type LoaderFunctionArgs } from 'react-router-dom';
import { compareResults, TestResult } from '@/lib/api';

const PerfBadge = ({ status }: { status?: string }) => {
  if (!status) return null;
  const cls: Record<string, string> = {
    passed:   'bg-green-bg text-green-fg-2',
    degraded: 'bg-amber-bg text-amber-badge-fg',
    failed:   'bg-red-bg text-red-badge-fg',
  };
  return <span className={`px-2 rounded-chip text-[10px] font-mono font-medium ${cls[status] ?? 'bg-surface-2 text-tx-3'}`}>{status}</span>;
};

const MetricRow = ({ label, a, b, unit = '' }: { label: string; a: number; b: number; unit?: string }) => {
  const diff = b - a;
  const pct = a !== 0 ? ((diff / a) * 100).toFixed(1) : '—';
  const worse = diff > 0;
  return (
    <tr className="border-b border-border-3 hover:bg-hover">
      <td className="py-2.5 px-4 text-[12.5px] text-tx-3">{label}</td>
      <td className="py-2.5 px-4 font-mono text-[12.5px] font-medium text-center">{Math.round(a)}{unit}</td>
      <td className="py-2.5 px-4 font-mono text-[12.5px] font-medium text-center">{Math.round(b)}{unit}</td>
      <td className={`py-2.5 px-4 font-mono text-[12.5px] text-center font-semibold ${diff === 0 ? 'text-tx-4' : worse ? 'text-red-fg' : 'text-green-fg'}`}>
        {diff === 0 ? '=' : `${worse ? '+' : ''}${pct}%`}
      </td>
    </tr>
  );
};

const backendMetrics = [
  { key: 'avgResponseTime', label: 'Avg response time', unit: 'ms' },
  { key: 'p50ResponseTime', label: 'p50 response time', unit: 'ms' },
  { key: 'p95ResponseTime', label: 'p95 response time', unit: 'ms' },
  { key: 'p99ResponseTime', label: 'p99 response time', unit: 'ms' },
  { key: 'rps',             label: 'Requests/sec',      unit: '' },
  { key: 'requestsTotal',   label: 'Total requests',    unit: '' },
  { key: 'requestsFailed',  label: 'Failed requests',   unit: '' },
];

const clientMetrics = [
  { key: 'lcp',  label: 'LCP',  unit: 'ms' },
  { key: 'fcp',  label: 'FCP',  unit: 'ms' },
  { key: 'ttfb', label: 'TTFB', unit: 'ms' },
  { key: 'fid',  label: 'FID',  unit: 'ms' },
  { key: 'cls',  label: 'CLS',  unit: '' },
];

export async function loader({ request }: LoaderFunctionArgs): Promise<{ resultA: TestResult; resultB: TestResult }> {
  const url = new URL(request.url);
  const a = url.searchParams.get('a') ?? '';
  const b = url.searchParams.get('b') ?? '';
  if (!a || !b) throw new Error('Provide ?a=<id>&b=<id> in the URL');
  try {
    return await compareResults(a, b);
  } catch {
    throw new Error('Failed to load results');
  }
}

export default function ComparePage() {
  const { resultA, resultB } = useLoaderData() as { resultA: TestResult; resultB: TestResult };
  const isBackend = resultA.type === 'backend';
  const rows = isBackend ? backendMetrics : clientMetrics;

  return (
    <div>
      <div className="px-4 md:px-9 pt-7.5 flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="font-mono text-[11px] tracking-[0.16em] text-accent uppercase mb-1.5">— History</div>
          <h1 className="font-display text-[clamp(26px,6.5vw,38px)] font-bold tracking-[-0.025em] leading-none">Compare Runs</h1>
        </div>
        <Link to="/results" className="text-[13px] text-accent hover:underline">← All results</Link>
      </div>

      <div className="px-4 md:px-9 py-6 max-w-3xl">
        <div className="bg-surface border border-border rounded-card overflow-hidden overflow-x-auto">
          <table className="w-full min-w-[480px]">
            <thead>
              <tr className="bg-surface-2 border-b border-border">
                <th className="py-3 px-4 text-left font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase">Metric</th>
                <th className="py-3 px-4 text-center font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase">
                  A
                  <div className="text-[10px] font-normal font-mono text-tx-4 mt-0.5">{new Date(resultA.created_at).toLocaleString()}</div>
                  <div className="mt-1"><PerfBadge status={resultA.perf_status} /></div>
                </th>
                <th className="py-3 px-4 text-center font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase">
                  B
                  <div className="text-[10px] font-normal font-mono text-tx-4 mt-0.5">{new Date(resultB.created_at).toLocaleString()}</div>
                  <div className="mt-1"><PerfBadge status={resultB.perf_status} /></div>
                </th>
                <th className="py-3 px-4 text-center font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase">Δ A→B</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ key, label, unit }) => (
                <MetricRow
                  key={key}
                  label={label}
                  a={((resultA.metrics as Record<string, number> | null)?.[key] ?? 0) as number}
                  b={((resultB.metrics as Record<string, number> | null)?.[key] ?? 0) as number}
                  unit={unit}
                />
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-3.5 flex gap-4">
          <Link to={`/results/${resultA.test_id}`} className="text-[12.5px] text-accent hover:underline">View result A →</Link>
          <Link to={`/results/${resultB.test_id}`} className="text-[12.5px] text-accent hover:underline">View result B →</Link>
        </div>
      </div>
    </div>
  );
}
