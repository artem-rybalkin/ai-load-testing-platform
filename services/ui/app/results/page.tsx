'use client';

import { useEffect, useState } from 'react';
import { getResults, TestResult } from '@/lib/api';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

export default function ResultsPage() {
  const [results, setResults] = useState<TestResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const router = useRouter();

  useEffect(() => {
    const fetch = async () => {
      const data = await getResults();
      setResults(data.results || []);
      setLoading(false);
    };
    fetch();
    const interval = setInterval(fetch, 5000);
    return () => clearInterval(interval);
  }, []);

  const toggleSelect = (testId: string) => {
    setSelected(prev =>
      prev.includes(testId) ? prev.filter(id => id !== testId) : prev.length < 2 ? [...prev, testId] : [prev[1], testId]
    );
  };

  const formatDate = (d: string) => new Date(d).toLocaleString();

  const getMainMetric = (r: TestResult) => {
    if (!r.metrics) return '—';
    if (r.type === 'backend') return `${r.metrics.rps?.toFixed(1) ?? 0} rps · p95: ${Math.round(r.metrics.p95ResponseTime)}ms`;
    return `LCP: ${Math.round(r.metrics.lcp)}ms · TTFB: ${Math.round(r.metrics.ttfb)}ms`;
  };

  return (
    <main className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-5xl mx-auto">

        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-gray-900">All results</h1>
          <div className="flex items-center gap-3">
            {selected.length === 2 && (
              <button
                onClick={() => router.push(`/results/compare?a=${selected[0]}&b=${selected[1]}`)}
                className="px-4 py-2 bg-amber-500 text-white rounded-lg text-sm font-medium hover:bg-amber-600"
              >
                Compare selected ({selected.length}/2)
              </button>
            )}
            {selected.length === 1 && (
              <span className="text-sm text-gray-500">Select one more to compare</span>
            )}
            <Link href="/" className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">
              + New test
            </Link>
          </div>
        </div>

        {loading ? (
          <p className="text-gray-500">Loading...</p>
        ) : results.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
            <p className="text-gray-500">No results yet</p>
            <Link href="/" className="text-blue-600 text-sm hover:underline mt-2 block">Run your first test →</Link>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 w-8"></th>
                  <th className="text-left px-4 py-3 text-gray-600 font-medium">URL</th>
                  <th className="text-left px-4 py-3 text-gray-600 font-medium">Type</th>
                  <th className="text-left px-4 py-3 text-gray-600 font-medium">Status</th>
                  <th className="text-left px-4 py-3 text-gray-600 font-medium">Analysis</th>
                  <th className="text-left px-4 py-3 text-gray-600 font-medium">Metrics</th>
                  <th className="text-left px-4 py-3 text-gray-600 font-medium">Date</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <tr key={r.id} className={`border-b border-gray-100 hover:bg-gray-50 ${i % 2 === 0 ? '' : 'bg-gray-50/50'} ${selected.includes(r.test_id) ? 'bg-amber-50' : ''}`}>
                    <td className="px-4 py-3">
                      {r.status === 'completed' && (
                        <input
                          type="checkbox"
                          checked={selected.includes(r.test_id)}
                          onChange={() => toggleSelect(r.test_id)}
                          className="rounded border-gray-300 text-amber-500 focus:ring-amber-400"
                        />
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-900 font-medium max-w-xs truncate">
                      {r.is_baseline && <span className="mr-1 text-amber-500 text-xs font-semibold">[B]</span>}
                      {r.target_url}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                        r.type === 'backend' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'
                      }`}>{r.type}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                        r.status === 'completed' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'
                      }`}>{r.status}</span>
                    </td>
                    <td className="px-4 py-3">
                      {r.perf_status && (
                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                          r.perf_status === 'passed'   ? 'bg-green-100 text-green-700' :
                          r.perf_status === 'degraded' ? 'bg-yellow-100 text-yellow-700' :
                                                        'bg-red-100 text-red-700'
                        }`}>
                          {r.perf_status === 'passed' ? '✅' : r.perf_status === 'degraded' ? '⚠️' : '❌'} {r.perf_status}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{getMainMetric(r)}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs">{formatDate(r.created_at)}</td>
                    <td className="px-4 py-3">
                      <Link href={`/results/${r.test_id}`} className="text-blue-600 hover:underline text-xs">
                        View →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}