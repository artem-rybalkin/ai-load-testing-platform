'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { getResult, getLiveMetrics, LiveMetricPoint, TestResult } from '@/lib/api';
import Link from 'next/link';
import BackendChart from '@/app/components/BackendChart';
import ClientChart from '@/app/components/ClientChart';
import AnalysisPanel from '@/app/components/AnalysisPanel';
import RealtimeChart from '@/app/components/RealtimeChart';


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
    completed: 'bg-green-100 text-green-700',
    running:   'bg-blue-100 text-blue-700',
    pending:   'bg-yellow-100 text-yellow-700',
    failed:    'bg-red-100 text-red-700'
  };
  return (
    <span className={`px-3 py-1 rounded-full text-xs font-medium ${colors[status] || 'bg-gray-100 text-gray-700'}`}>
      {status}
    </span>
  );
};

export default function ResultPage() {
  const { testId } = useParams<{ testId: string }>();
  const [result, setResult] = useState<TestResult | null>(null);
  const [livePoints, setLivePoints] = useState<LiveMetricPoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchResult = async () => {
      try {
        const data = await getResult(testId);
        if (data.result) setResult(data.result);
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
    if (!result || result.type !== 'backend') return;
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
  const isBackend = result.type === 'backend';

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
            </div>
            <p className="text-gray-500 text-sm">{result.target_url}</p>
          </div>
          <Link href="/results" className="text-sm text-blue-600 hover:underline">← All results</Link>
        </div>

        {isBackend && livePoints.length > 0 && (
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-3">
              {result.status === 'running' && (
                <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse inline-block" />
              )}
              <span className="text-sm font-medium text-gray-600">
                {result.status === 'running' ? 'Live metrics' : 'Test timeline'}
              </span>
            </div>
            <RealtimeChart points={livePoints} />
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
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <MetricCard label="Total requests" value={m.requestsTotal} />
                <MetricCard label="Failed requests" value={m.requestsFailed} />
                <MetricCard label="Requests/sec" value={m.rps?.toFixed(1) ?? 0} />
                <MetricCard label="Avg response time" value={Math.round(m.avgResponseTime)} unit="ms" />
                <MetricCard label="p95 response time" value={Math.round(m.p95ResponseTime)} unit="ms" />
                <MetricCard label="p99 response time" value={Math.round(m.p99ResponseTime)} unit="ms" />
              </div>
                      <BackendChart metrics={m as any} />
      </>
    ) : (
      <ClientChart metrics={m as any} />
    )}
            {result.analysis && (
        <AnalysisPanel analysis={result.analysis as any} />
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