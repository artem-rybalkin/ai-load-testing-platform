'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { getResult, getLiveMetrics, getTrend, setBaseline, clearBaseline, cancelTest, LiveMetricPoint, TestResult, TrendPoint } from '@/lib/api';
import Link from 'next/link';
import BackendChart from '@/app/components/BackendChart';
import ClientChart from '@/app/components/ClientChart';
import AnalysisPanel from '@/app/components/AnalysisPanel';
import RealtimeChart from '@/app/components/RealtimeChart';
import TrendChart from '@/app/components/TrendChart';


interface StepMetric { name: string; avgResponseTime: number; p95ResponseTime: number; requestsTotal: number; requestsFailed: number }

const StepMetricsTable = ({ steps }: { steps: StepMetric[] }) => (
  <div className="bg-white rounded-xl border border-gray-200 p-4">
    <h2 className="text-sm font-medium text-gray-700 mb-3">Per-step breakdown</h2>
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-gray-500 border-b border-gray-100">
            <th className="text-left py-1 pr-4 font-medium">Step</th>
            <th className="text-right py-1 px-2 font-medium">Requests</th>
            <th className="text-right py-1 px-2 font-medium">Failed</th>
            <th className="text-right py-1 px-2 font-medium">Avg (ms)</th>
            <th className="text-right py-1 pl-2 font-medium">p95 (ms)</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s, i) => (
            <tr key={i} className="border-b border-gray-50 last:border-0">
              <td className="py-2 pr-4 text-gray-800 font-medium">{s.name}</td>
              <td className="text-right px-2 text-gray-600">{s.requestsTotal}</td>
              <td className={`text-right px-2 ${s.requestsFailed > 0 ? 'text-red-600 font-medium' : 'text-gray-400'}`}>{s.requestsFailed}</td>
              <td className="text-right px-2 text-gray-600">{Math.round(s.avgResponseTime)}</td>
              <td className={`text-right pl-2 font-medium ${s.p95ResponseTime > 1000 ? 'text-red-600' : s.p95ResponseTime > 500 ? 'text-yellow-600' : 'text-green-600'}`}>{Math.round(s.p95ResponseTime)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </div>
);

const MetricCard = ({ label, value, unit }: { label: string; value: number | string; unit?: string }) => (
  <div className="bg-white rounded-xl border border-gray-200 p-4">
    <p className="text-xs text-gray-500 mb-1">{label}</p>
    <p className="text-2xl font-bold text-gray-900">
      {value}<span className="text-sm font-normal text-gray-500 ml-1">{unit}</span>
    </p>
  </div>
);

const StatusBadge = ({ status }: { status: string }) => {
  const colors: Record<string, string> = {
    completed:  'bg-green-100 text-green-700',
    running:    'bg-blue-100 text-blue-700',
    pending:    'bg-yellow-100 text-yellow-700',
    failed:     'bg-red-100 text-red-700',
    cancelled:  'bg-gray-100 text-gray-600',
  };
  return (
    <span className={`px-3 py-1 rounded-full text-xs font-medium ${colors[status] || 'bg-gray-100 text-gray-700'}`}>
      {status}
    </span>
  );
};

const fmtRemaining = (secs: number): string => {
  if (secs <= 0) return 'finishing…';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
};

export default function ResultPage() {
  const { testId } = useParams<{ testId: string }>();
  const [result, setResult] = useState<TestResult | null>(null);
  const [livePoints, setLivePoints] = useState<LiveMetricPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [baselineBusy, setBaselineBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [remainingSecs, setRemainingSecs] = useState<number | null>(null);

  const handleCancel = async () => {
    setCancelling(true);
    try {
      await cancelTest(testId);
      const data = await getResult(testId);
      if (data.result) setResult(data.result);
    } finally {
      setCancelling(false);
    }
  };
  const [trend, setTrend] = useState<TrendPoint[]>([]);

  // Countdown timer — ticks every second while the test is running
  useEffect(() => {
    if (result?.status !== 'running' || !result.started_at || !result.duration_seconds) {
      setRemainingSecs(null);
      return;
    }
    const tick = () => {
      const elapsed = (Date.now() - new Date(result.started_at!).getTime()) / 1000;
      setRemainingSecs(Math.max(0, result.duration_seconds! - elapsed));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [result?.status, result?.started_at, result?.duration_seconds]);

  const handleBaseline = async () => {
    if (!result) return;
    setBaselineBusy(true);
    try {
      if (result.is_baseline) {
        await clearBaseline(testId);
      } else {
        await setBaseline(testId);
      }
      const data = await getResult(testId);
      if (data.result) setResult(data.result);
    } finally {
      setBaselineBusy(false);
    }
  };

  useEffect(() => {
    const fetchResult = async () => {
      try {
        const data = await getResult(testId);
        if (data.result) {
          setResult(data.result);
          if (data.result.status === 'completed') {
            getTrend(data.result.target_url).then(d => setTrend(d.trend ?? [])).catch(() => {});
          }
        }
      } catch {
        console.error('Failed to fetch result');
      } finally {
        setLoading(false);
      }
    };

    fetchResult();

    const resultInterval = setInterval(async () => {
      const data = await getResult(testId);
      if (data.result) {
        setResult(data.result);
        if (data.result.status === 'completed' || data.result.status === 'failed') {
          clearInterval(resultInterval);
        }
      }
    }, 2000);

    return () => clearInterval(resultInterval);
  }, [testId]);

  // Poll live metrics while test is running
  useEffect(() => {
    if (!result || (result.type !== 'backend' && result.type !== 'flow')) return;
    if (result.status === 'completed' || result.status === 'failed') {
      // Do a final fetch to show the complete live data
      getLiveMetrics(testId).then(d => setLivePoints(d.points ?? [])).catch(() => {});
      return;
    }

    const liveInterval = setInterval(async () => {
      try {
        const data = await getLiveMetrics(testId);
        setLivePoints(data.points ?? []);
      } catch { /* ignore */ }
    }, 3000);

    return () => clearInterval(liveInterval);
  }, [testId, result?.status, result?.type]);

  if (loading) return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <p className="text-gray-500">Loading...</p>
    </div>
  );
if (!result) return (
  <div className="min-h-screen bg-gray-50 flex items-center justify-center">
    <div className="text-center">
      <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full mx-auto mb-4"></div>
      <p className="text-gray-600 font-medium mb-1">AI is generating the test script...</p>
      <p className="text-xs text-gray-400 mb-6">This usually takes 10-30 seconds</p>
      <div className="flex gap-3 justify-center">
        <a href="/" className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">
          + New test
        </a>
        <a href="/results" className="px-4 py-2 border border-gray-300 text-gray-600 rounded-lg text-sm font-medium hover:bg-gray-50">
          All results
        </a>
      </div>
    </div>
  </div>
);

  const m = result.metrics;
  const isBackend = result.type === 'backend' || result.type === 'flow';

  return (
    <main className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-4xl mx-auto">

        <div className="flex items-center justify-between mb-6">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h1 className="text-2xl font-bold text-gray-900">Test result</h1>
              <StatusBadge status={result.status} />
              {result.reused_script && (
                <span className="px-2 py-1 bg-purple-100 text-purple-700 rounded-full text-xs font-medium">
                  script reused
                </span>
              )}
              {result.is_baseline && (
                <span className="px-2 py-1 bg-amber-100 text-amber-700 rounded-full text-xs font-medium">
                  baseline
                </span>
              )}
            </div>
            <p className="text-gray-500 text-sm">{result.target_url}</p>
          </div>
          <div className="flex items-center gap-3">
            {(result.status === 'pending' || result.status === 'running') && (
              <button
                onClick={handleCancel}
                disabled={cancelling}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border border-red-300 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
              >
                {cancelling ? 'Cancelling…' : 'Cancel test'}
              </button>
            )}
            {result.status === 'completed' && (
              <>
                <button
                  onClick={handleBaseline}
                  disabled={baselineBusy}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors disabled:opacity-50 ${
                    result.is_baseline
                      ? 'border-amber-300 text-amber-700 hover:bg-amber-50'
                      : 'border-gray-300 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {result.is_baseline ? 'Clear baseline' : 'Set as baseline'}
                </button>
                <a
                  href={`${process.env.NEXT_PUBLIC_RESULTS_URL || 'http://localhost:3004'}/results/${testId}/report.pdf`}
                  target="_blank"
                  rel="noreferrer"
                  className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-300 text-gray-600 hover:bg-gray-50"
                >
                  Download PDF
                </a>
              </>
            )}
            <Link href="/results" className="text-sm text-blue-600 hover:underline">← All results</Link>
          </div>
        </div>

        {isBackend && livePoints.length > 0 && (
          <div className="mb-6">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                {result.status === 'running' && (
                  <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse inline-block" />
                )}
                <span className="text-sm font-medium text-gray-600">
                  {result.status === 'running' ? 'Live metrics' : 'Test timeline'}
                </span>
              </div>
              {result.status === 'running' && remainingSecs !== null && (
                <span className="text-xs font-medium text-blue-600 tabular-nums">
                  {fmtRemaining(remainingSecs)} remaining
                </span>
              )}
            </div>
            {result.status === 'running' && result.duration_seconds && remainingSecs !== null && (
              <div className="mb-3 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 rounded-full transition-all duration-1000"
                  style={{ width: `${Math.min(100, ((result.duration_seconds - remainingSecs) / result.duration_seconds) * 100)}%` }}
                />
              </div>
            )}
            <RealtimeChart points={livePoints} startedAt={result.started_at} />
          </div>
        )}

        {result.status === 'pending' || !result.metrics ? (
          <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
            <div className="animate-pulse">
              <p className="text-gray-500">Test is running...</p>
              <p className="text-xs text-gray-400 mt-1">Page updates every 2 seconds</p>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {isBackend ? (
                <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <MetricCard label="Total requests" value={m.requestsTotal} />
                <MetricCard label="Failed requests" value={m.requestsFailed} />
                <MetricCard label="Requests/sec" value={m.rps?.toFixed(1) ?? 0} />
                <MetricCard label="Avg response time" value={Math.round(m.avgResponseTime)} unit="ms" />
                <MetricCard label="p50 response time" value={Math.round(m.p50ResponseTime ?? 0)} unit="ms" />
                <MetricCard label="p95 response time" value={Math.round(m.p95ResponseTime)} unit="ms" />
                <MetricCard label="p99 response time" value={Math.round(m.p99ResponseTime)} unit="ms" />
                {m.statusCodes && Object.keys(m.statusCodes as unknown as Record<string,number>).length > 0 && (
                  <div className="bg-white rounded-xl border border-gray-200 p-4">
                    <p className="text-xs text-gray-500 mb-1">Status codes</p>
                    <div className="space-y-0.5">
                      {Object.entries(m.statusCodes as unknown as Record<string,number>).sort().map(([code, count]) => (
                        <p key={code} className="text-sm font-semibold text-gray-900">
                          <span className={`mr-1 ${code.startsWith('2') ? 'text-green-600' : code.startsWith('4') || code.startsWith('5') ? 'text-red-600' : 'text-gray-600'}`}>{code}</span>
                          <span className="text-gray-500 font-normal text-xs">×{count}</span>
                        </p>
                      ))}
                    </div>
                  </div>
                )}
              </div>
                      <BackendChart metrics={m as any} />
                      {(m as any).stepMetrics?.length > 0 && (
                        <StepMetricsTable steps={(m as any).stepMetrics} />
                      )}
      </>
    ) : (
      <ClientChart metrics={m as any} />
    )}
            {result.analysis && (
              <AnalysisPanel analysis={result.analysis as any} />
            )}
            {trend.length > 1 && (
              <div className="bg-white rounded-xl border border-gray-200 p-4">
                <h2 className="text-sm font-medium text-gray-700 mb-3">
                  Trend for this URL <span className="text-gray-400 font-normal">({trend.length} runs)</span>
                </h2>
                <TrendChart
                  trend={trend}
                  metricKey={isBackend ? 'p95ResponseTime' : 'lcp'}
                  label={isBackend ? 'p95 (ms)' : 'LCP (ms)'}
                />
              </div>
            )}
            {result.script && (
              <div className="bg-white rounded-xl border border-gray-200 p-4">
                <h2 className="text-sm font-medium text-gray-700 mb-3">Generated script</h2>
                <pre className="text-xs text-gray-600 bg-gray-50 rounded-lg p-4 overflow-auto max-h-64">
                  {result.script}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}