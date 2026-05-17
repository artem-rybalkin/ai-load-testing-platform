'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { compareResults, TestResult } from '@/lib/api';
import Link from 'next/link';

const PerfBadge = ({ status }: { status?: string }) => {
  if (!status) return null;
  const cls: Record<string, string> = {
    passed:  'bg-[#dafbe1] text-[#1a7f37]',
    degraded:'bg-[#fff8c5] text-[#9a6700]',
    failed:  'bg-[#ffebe9] text-[#cf222e]',
  };
  return <span className={`px-1.5 rounded text-[10px] font-mono font-medium ${cls[status] ?? 'bg-[#f6f8fa] text-[#57606a]'}`}>{status}</span>;
};

const MetricRow = ({ label, a, b, unit = '' }: { label: string; a: number; b: number; unit?: string }) => {
  const diff = b - a;
  const pct = a !== 0 ? ((diff / a) * 100).toFixed(1) : '—';
  const worse = diff > 0;
  return (
    <tr className="border-b border-[#eaeef2] hover:bg-[#f6f8fa]">
      <td className="py-2 px-3 text-[12px] text-[#57606a]">{label}</td>
      <td className="py-2 px-3 text-[12px] font-mono font-medium text-center text-[#24292f]">{Math.round(a)}{unit}</td>
      <td className="py-2 px-3 text-[12px] font-mono font-medium text-center text-[#24292f]">{Math.round(b)}{unit}</td>
      <td className={`py-2 px-3 text-[12px] font-mono text-center font-semibold ${diff === 0 ? 'text-[#8c959f]' : worse ? 'text-[#cf222e]' : 'text-[#1f883d]'}`}>
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

function CompareContent() {
  const params = useSearchParams();
  const a = params.get('a') ?? '';
  const b = params.get('b') ?? '';
  const [results, setResults] = useState<{ resultA: TestResult; resultB: TestResult } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!a || !b) { setError('Provide ?a=<id>&b=<id> in the URL'); return; }
    compareResults(a, b).then(setResults).catch(() => setError('Failed to load results'));
  }, [a, b]);

  if (error) return (
    <div className="flex items-center justify-center h-40 text-[#cf222e] text-[13px]">{error}</div>
  );
  if (!results) return (
    <div className="flex items-center justify-center h-40 text-[#57606a] text-[13px]">Loading…</div>
  );

  const { resultA, resultB } = results;
  const isBackend = resultA.type === 'backend';
  const rows = isBackend ? backendMetrics : clientMetrics;

  return (
    <div className="p-4 lg:p-6 max-w-3xl">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-[15px] font-semibold text-[#24292f]">Compare Runs</h1>
        <Link href="/results" className="text-[12px] text-[#0969da] hover:underline">← All results</Link>
      </div>

      <div className="bg-white border border-[#d0d7de] rounded-md overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="bg-[#f6f8fa] border-b border-[#d0d7de]">
              <th className="py-2 px-3 text-left text-[11px] font-semibold text-[#57606a] uppercase tracking-wide">Metric</th>
              <th className="py-2 px-3 text-center text-[11px] font-semibold text-[#57606a] uppercase tracking-wide">
                A
                <div className="text-[10px] font-normal font-mono text-[#8c959f] mt-0.5">{new Date(resultA.created_at).toLocaleString()}</div>
                <div className="mt-1"><PerfBadge status={resultA.perf_status} /></div>
              </th>
              <th className="py-2 px-3 text-center text-[11px] font-semibold text-[#57606a] uppercase tracking-wide">
                B
                <div className="text-[10px] font-normal font-mono text-[#8c959f] mt-0.5">{new Date(resultB.created_at).toLocaleString()}</div>
                <div className="mt-1"><PerfBadge status={resultB.perf_status} /></div>
              </th>
              <th className="py-2 px-3 text-center text-[11px] font-semibold text-[#57606a] uppercase tracking-wide">Δ A→B</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ key, label, unit }) => (
              <MetricRow
                key={key}
                label={label}
                a={(resultA.metrics[key] ?? 0) as number}
                b={(resultB.metrics[key] ?? 0) as number}
                unit={unit}
              />
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex gap-4">
        <Link href={`/results/${resultA.test_id}`} className="text-[12px] text-[#0969da] hover:underline">View result A →</Link>
        <Link href={`/results/${resultB.test_id}`} className="text-[12px] text-[#0969da] hover:underline">View result B →</Link>
      </div>
    </div>
  );
}

export default function ComparePage() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-gray-50 flex items-center justify-center"><p className="text-gray-500">Loading...</p></main>}>
      <CompareContent />
    </Suspense>
  );
}
