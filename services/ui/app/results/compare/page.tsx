'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { compareResults, TestResult } from '@/lib/api';
import Link from 'next/link';

const PerfBadge = ({ status }: { status?: string }) => {
  if (!status) return null;
  const colors: Record<string, string> = {
    passed: 'bg-green-100 text-green-700',
    degraded: 'bg-yellow-100 text-yellow-700',
    failed: 'bg-red-100 text-red-700',
  };
  return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] ?? 'bg-gray-100 text-gray-700'}`}>{status}</span>;
};

const MetricRow = ({ label, a, b, unit = '' }: { label: string; a: number; b: number; unit?: string }) => {
  const diff = b - a;
  const pct = a !== 0 ? ((diff / a) * 100).toFixed(1) : '—';
  const worse = diff > 0;
  return (
    <tr className="border-b border-gray-100">
      <td className="py-2 px-3 text-sm text-gray-600">{label}</td>
      <td className="py-2 px-3 text-sm font-medium text-center">{Math.round(a)}{unit}</td>
      <td className="py-2 px-3 text-sm font-medium text-center">{Math.round(b)}{unit}</td>
      <td className={`py-2 px-3 text-sm text-center font-medium ${diff === 0 ? 'text-gray-400' : worse ? 'text-red-600' : 'text-green-600'}`}>
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
    <main className="min-h-screen bg-gray-50 flex items-center justify-center">
      <p className="text-red-500">{error}</p>
    </main>
  );
  if (!results) return (
    <main className="min-h-screen bg-gray-50 flex items-center justify-center">
      <p className="text-gray-500">Loading...</p>
    </main>
  );

  const { resultA, resultB } = results;
  const isBackend = resultA.type === 'backend';
  const rows = isBackend ? backendMetrics : clientMetrics;

  return (
    <main className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Compare runs</h1>
          <Link href="/results" className="text-sm text-blue-600 hover:underline">← All results</Link>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="py-3 px-3 text-left text-gray-600 font-medium">Metric</th>
                <th className="py-3 px-3 text-center text-gray-600 font-medium">
                  A<br />
                  <span className="text-xs font-normal text-gray-400">{new Date(resultA.created_at).toLocaleString()}</span>
                  <div className="mt-1"><PerfBadge status={resultA.perf_status} /></div>
                </th>
                <th className="py-3 px-3 text-center text-gray-600 font-medium">
                  B<br />
                  <span className="text-xs font-normal text-gray-400">{new Date(resultB.created_at).toLocaleString()}</span>
                  <div className="mt-1"><PerfBadge status={resultB.perf_status} /></div>
                </th>
                <th className="py-3 px-3 text-center text-gray-600 font-medium">Δ A→B</th>
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

        <div className="mt-4 flex gap-3 text-xs text-gray-500">
          <Link href={`/results/${resultA.test_id}`} className="text-blue-600 hover:underline">View result A →</Link>
          <Link href={`/results/${resultB.test_id}`} className="text-blue-600 hover:underline">View result B →</Link>
        </div>
      </div>
    </main>
  );
}

export default function ComparePage() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-gray-50 flex items-center justify-center"><p className="text-gray-500">Loading...</p></main>}>
      <CompareContent />
    </Suspense>
  );
}
