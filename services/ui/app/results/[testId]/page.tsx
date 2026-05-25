'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { getResult, getLiveMetrics, getTrend, setBaseline, clearBaseline, cancelTest, LiveMetricPoint, TestResult, TrendPoint } from '@/lib/api';
import Link from 'next/link';
import dynamic from 'next/dynamic';
const BackendChart  = dynamic(() => import('@/app/components/BackendChart'),  { ssr: false });
const ClientChart   = dynamic(() => import('@/app/components/ClientChart'),   { ssr: false });
const FlowStepChart = dynamic(() => import('@/app/components/FlowStepChart'), { ssr: false });
const AnalysisPanel = dynamic(() => import('@/app/components/AnalysisPanel'), { ssr: false });
const RealtimeChart = dynamic(() => import('@/app/components/RealtimeChart'), { ssr: false });
const TrendChart    = dynamic(() => import('@/app/components/TrendChart'),    { ssr: false });

interface StepMetric { name: string; avgResponseTime: number; p95ResponseTime: number; requestsTotal: number; requestsFailed: number }

const fmtRemaining = (secs: number) => {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
};

const StatusBadge = ({ status }: { status: string }) => {
  const cls: Record<string, string> = {
    completed: 'bg-[#dafbe1] text-[#1a7f37]',
    running:   'bg-[#ddf4ff] text-[#0969da]',
    pending:   'bg-[#fff8c5] text-[#9a6700]',
    failed:    'bg-[#ffebe9] text-[#cf222e]',
    cancelled: 'bg-[#f6f8fa] text-[#57606a]',
  };
  return (
    <span className={`px-2 py-0.5 rounded text-[11px] font-mono font-medium ${cls[status] ?? 'bg-[#f6f8fa] text-[#57606a]'}`}>
      {status}
    </span>
  );
};

const BentoCard = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => (
  <div className={`bg-white border border-[#d0d7de] rounded-md overflow-hidden ${className}`}>
    {children}
  </div>
);

const CardHeader = ({ title }: { title: string }) => (
  <div className="px-3 py-2 border-b border-[#d0d7de] bg-[#f6f8fa]">
    <span className="text-[11px] font-semibold text-[#57606a] uppercase tracking-wide">{title}</span>
  </div>
);

const MetricCell = ({
  label, value, unit, color,
}: { label: string; value: number | string; unit?: string; color?: string }) => (
  <BentoCard>
    <div className="p-3">
      <div className="text-[10px] font-mono font-semibold text-[#57606a] uppercase tracking-wide mb-1">{label}</div>
      <div className={`text-[22px] font-mono font-bold leading-none ${color ?? 'text-[#24292f]'}`}>
        {value}
        {unit && <span className="text-[13px] font-normal text-[#57606a] ml-1">{unit}</span>}
      </div>
    </div>
  </BentoCard>
);

const StepMetricsTable = ({ steps }: { steps: StepMetric[] }) => (
  <BentoCard className="col-span-full">
    <CardHeader title="Per-step breakdown" />
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-[#eaeef2]">
            {['Step', 'Requests', 'Failed', 'Avg ms', 'p95 ms'].map(h => (
              <th key={h} className={`py-2 px-3 text-[11px] font-semibold text-[#57606a] ${h === 'Step' ? 'text-left' : 'text-right'}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[#eaeef2]">
          {steps.map((s, i) => (
            <tr key={i} className="hover:bg-[#f6f8fa]">
              <td className="py-2 px-3 text-[13px] font-medium text-[#24292f]">{s.name}</td>
              <td className="py-2 px-3 text-right font-mono text-[12px] text-[#57606a]">{s.requestsTotal}</td>
              <td className={`py-2 px-3 text-right font-mono text-[12px] ${s.requestsFailed > 0 ? 'text-[#cf222e] font-semibold' : 'text-[#8c959f]'}`}>{s.requestsFailed}</td>
              <td className="py-2 px-3 text-right font-mono text-[12px] text-[#57606a]">{Math.round(s.avgResponseTime)}</td>
              <td className={`py-2 px-3 text-right font-mono text-[12px] font-semibold ${s.p95ResponseTime > 1000 ? 'text-[#cf222e]' : s.p95ResponseTime > 500 ? 'text-[#9a6700]' : 'text-[#1f883d]'}`}>
                {Math.round(s.p95ResponseTime)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </BentoCard>
);

export default function ResultPage() {
  const { testId } = useParams<{ testId: string }>();
  const [result, setResult] = useState<TestResult | null>(null);
  const [livePoints, setLivePoints] = useState<LiveMetricPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [baselineBusy, setBaselineBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [remainingSecs, setRemainingSecs] = useState<number | null>(null);
  const [trend, setTrend] = useState<TrendPoint[]>([]);

  const handleCancel = async () => {
    setCancelling(true);
    try {
      await cancelTest(testId);
      const data = await getResult(testId);
      if (data.result) setResult(data.result);
    } finally { setCancelling(false); }
  };

  const handleBaseline = async () => {
    if (!result) return;
    setBaselineBusy(true);
    try {
      if (result.is_baseline) await clearBaseline(testId);
      else await setBaseline(testId);
      const data = await getResult(testId);
      if (data.result) setResult(data.result);
    } finally { setBaselineBusy(false); }
  };

  // Countdown
  useEffect(() => {
    if (result?.status !== 'running' || !result.started_at || !result.duration_seconds) {
      setRemainingSecs(null); return;
    }
    const tick = () => {
      const elapsed = (Date.now() - new Date(result.started_at!).getTime()) / 1000;
      setRemainingSecs(Math.max(0, result.duration_seconds! - elapsed));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [result?.status, result?.started_at, result?.duration_seconds]);

  // Poll result
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
      } catch { /* ignore */ } finally { setLoading(false); }
    };
    fetchResult();
    const iv = setInterval(async () => {
      const data = await getResult(testId);
      if (data.result) {
        setResult(data.result);
        if (data.result.status === 'completed' || data.result.status === 'failed') clearInterval(iv);
      }
    }, 2000);
    return () => clearInterval(iv);
  }, [testId]);

  // Poll live metrics
  useEffect(() => {
    if (!result || (result.type !== 'backend' && result.type !== 'flow')) return;

    const fetchLive = async () => {
      try {
        const data = await getLiveMetrics(testId);
        setLivePoints(data.points ?? []);
      } catch { /* ignore */ }
    };

    // Always fetch immediately — avoids waiting 3s on first render or after status change
    fetchLive();

    if (result.status === 'completed' || result.status === 'failed') return;

    const iv = setInterval(fetchLive, 2000);
    return () => clearInterval(iv);
  }, [testId, result?.status, result?.type]);

  if (loading) return (
    <div className="flex items-center justify-center h-40 text-[#57606a] text-[13px]">Loading…</div>
  );

  if (!result) return (
    <div className="flex items-center justify-center h-48">
      <div className="text-center">
        <div className="animate-spin w-6 h-6 border-2 border-[#0969da] border-t-transparent rounded-full mx-auto mb-3" />
        <p className="text-[#24292f] font-medium text-[13px] mb-1">Generating test script…</p>
        <p className="text-[#57606a] text-[11px] mb-4">This usually takes 10–30 seconds</p>
        <div className="flex gap-2 justify-center">
          <Link href="/" className="px-3 py-1.5 bg-[#1f883d] text-white rounded-md text-[12px] font-medium">+ New test</Link>
          <Link href="/results" className="px-3 py-1.5 border border-[#d0d7de] text-[#24292f] rounded-md text-[12px]">All results</Link>
        </div>
      </div>
    </div>
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = result.metrics as Record<string, any>;
  const isBackend = result.type === 'backend' || result.type === 'flow';
  const isRunning   = result.status === 'running';
  const isPending   = result.status === 'pending';
  const isTerminal  = result.status === 'cancelled' || result.status === 'failed';
  const pct = result.duration_seconds && remainingSecs !== null
    ? Math.min(100, ((result.duration_seconds - remainingSecs) / result.duration_seconds) * 100)
    : 0;

  return (
    <div className="p-4 lg:p-6">
      {/* Page header */}
      <div className="mb-1">
        <Link href="/results" className="text-[11px] text-[#57606a] hover:text-[#0969da] hover:underline">← All Results</Link>
      </div>
      <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="text-[15px] font-semibold text-[#24292f] font-mono">{result.target_url}</h1>
          <StatusBadge status={result.status} />
          {result.reused_script && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-[#faf5ff] text-[#7c3aed] border border-[#e9d5ff]">script reused</span>
          )}
          {result.is_baseline && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-[#fff8c5] text-[#9a6700] border border-[#e3b341]">baseline</span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {(isPending || isRunning) && (
            <button
              onClick={handleCancel}
              disabled={cancelling}
              className="px-2.5 py-1 rounded-md text-[12px] font-medium border border-[#f4c7c3] text-[#cf222e] hover:bg-[#ffebe9] disabled:opacity-50 transition-colors"
            >
              {cancelling ? 'Cancelling…' : 'Cancel'}
            </button>
          )}
          {result.status === 'completed' && (
            <>
              <button
                onClick={handleBaseline}
                disabled={baselineBusy}
                className={`px-2.5 py-1 rounded-md text-[12px] font-medium border transition-colors disabled:opacity-50 ${
                  result.is_baseline
                    ? 'border-[#e3b341] text-[#9a6700] hover:bg-[#fff8c5]'
                    : 'border-[#d0d7de] text-[#24292f] hover:bg-[#eaeef2]'
                }`}
              >
                {result.is_baseline ? 'Clear baseline' : 'Set baseline'}
              </button>
              <a
                href={`${process.env.NEXT_PUBLIC_RESULTS_URL || 'http://localhost:3004'}/results/${testId}/report.pdf`}
                target="_blank"
                rel="noreferrer"
                className="px-2.5 py-1 rounded-md text-[12px] font-medium border border-[#d0d7de] text-[#24292f] hover:bg-[#eaeef2] transition-colors"
              >
                ↓ PDF
              </a>
            </>
          )}
        </div>
      </div>

      {/* Progress bar (running) */}
      {isRunning && result.duration_seconds && remainingSecs !== null && (
        <div className="flex items-center gap-3 mb-4 bg-white border border-[#d0d7de] rounded-md px-3 py-2">
          <span className="flex items-center gap-1.5 text-[11px] font-mono text-[#0969da] font-semibold whitespace-nowrap">
            <span className="w-1.5 h-1.5 bg-[#0969da] rounded-full animate-pulse" />
            LIVE
          </span>
          <div className="flex-1 h-1.5 bg-[#eaeef2] rounded-full overflow-hidden">
            <div
              className="h-full bg-[#0969da] rounded-full transition-all duration-1000"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-[11px] font-mono text-[#57606a] whitespace-nowrap">
            {remainingSecs <= 0 ? 'finishing…' : `${fmtRemaining(remainingSecs)} left`}
          </span>
        </div>
      )}

      {/* Live chart — shown while running (before metrics arrive) and after completion */}
      {isBackend && livePoints.length > 0 && (isPending || !m) && (
        <BentoCard className="mb-3">
          <CardHeader title={isRunning ? 'Live Metrics' : 'Test Timeline'} />
          <div className="p-3">
            <RealtimeChart points={livePoints} startedAt={result.started_at} />
          </div>
        </BentoCard>
      )}

      {/* Pending / running / terminal-no-metrics state */}
      {(isPending || isRunning || (!m && isTerminal)) ? (
        <BentoCard>
          <div className="p-8 text-center">
            {isTerminal ? (
              <p className="text-[#57606a] text-[13px]">
                Test {result.status} — no metrics collected.
              </p>
            ) : (
              <div className="animate-pulse">
                <p className="text-[#57606a] text-[13px]">
                  {isPending ? 'Waiting in queue…' : 'Test is running…'}
                </p>
                <p className="text-[#8c959f] text-[11px] mt-1">
                  {isPending ? 'AI is generating the test script' : 'Page updates every 2 seconds'}
                </p>
              </div>
            )}
            {result.status_message && (
              <p className={`text-[11px] font-mono mt-3 ${
                result.status_message.includes('failed') || result.status_message.includes('unavailable')
                  ? 'text-[#9a6700]'
                  : result.status_message.includes('ready') || result.status_message.includes('starting')
                    ? 'text-[#1f883d]'
                    : 'text-[#57606a]'
              }`}>
                {result.status_message}
              </p>
            )}
            {!isTerminal && remainingSecs !== null && (
              <div className="mt-4 max-w-xs mx-auto">
                <p className="text-[12px] font-mono text-[#0969da] mb-2">
                  {remainingSecs <= 0 ? 'finishing…' : `${fmtRemaining(remainingSecs)} remaining`}
                </p>
                {result.duration_seconds && (
                  <div className="h-1.5 bg-[#eaeef2] rounded-full overflow-hidden">
                    <div className="h-full bg-[#0969da] rounded-full transition-all duration-1000" style={{ width: `${pct}%` }} />
                  </div>
                )}
              </div>
            )}
          </div>
        </BentoCard>
      ) : (
        /* ── Bento grid ── */
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-12 gap-3">

          {/* ── Metric cells (top row) ── */}
          {isBackend ? (
            <>
              <div className="col-span-1 md:col-span-1 lg:col-span-3">
                <MetricCell label="Total Requests" value={m.requestsTotal} />
              </div>
              <div className="col-span-1 md:col-span-1 lg:col-span-3">
                <MetricCell label="Req / sec" value={(m.rps ?? 0).toFixed(1)} color="text-[#0969da]" />
              </div>
              <div className="col-span-1 md:col-span-1 lg:col-span-3">
                <MetricCell
                  label="Failed"
                  value={m.requestsFailed}
                  unit={`/ ${m.requestsTotal > 0 ? ((m.requestsFailed / m.requestsTotal) * 100).toFixed(1) : 0}%`}
                  color={m.requestsFailed > 0 ? 'text-[#cf222e]' : 'text-[#24292f]'}
                />
              </div>
              <div className="col-span-1 md:col-span-1 lg:col-span-3">
                <MetricCell label="p95 Response" value={Math.round(m.p95ResponseTime ?? 0)} unit="ms" />
              </div>
            </>
          ) : (
            <>
              <div className="col-span-1 md:col-span-1 lg:col-span-3">
                <MetricCell label="LCP" value={Math.round(m.lcp ?? 0)} unit="ms" color={(m.lcp ?? 0) > 2500 ? 'text-[#cf222e]' : 'text-[#1f883d]'} />
              </div>
              <div className="col-span-1 md:col-span-1 lg:col-span-3">
                <MetricCell label="FCP" value={Math.round(m.fcp ?? 0)} unit="ms" />
              </div>
              <div className="col-span-1 md:col-span-1 lg:col-span-3">
                <MetricCell label="TTFB" value={Math.round(m.ttfb ?? 0)} unit="ms" />
              </div>
              <div className="col-span-1 md:col-span-1 lg:col-span-3">
                <MetricCell label="CLS" value={(m.cls ?? 0).toFixed(3)} color={(m.cls ?? 0) > 0.1 ? 'text-[#cf222e]' : 'text-[#1f883d]'} />
              </div>
            </>
          )}

          {/* ── Live / timeline chart (also shown pre-metrics via the block above) ── */}
          {isBackend && livePoints.length > 0 && (
            <div className="col-span-full">
              <BentoCard>
                <CardHeader title="Test Timeline" />
                <div className="p-3">
                  <RealtimeChart points={livePoints} startedAt={result.started_at} />
                </div>
              </BentoCard>
            </div>
          )}

          {/* ── Backend: more metric cells ── */}
          {isBackend && (
            <>
              <div className="col-span-1 lg:col-span-3">
                <MetricCell label="Avg Response" value={Math.round(m.avgResponseTime ?? 0)} unit="ms" />
              </div>
              <div className="col-span-1 lg:col-span-3">
                <MetricCell label="p50 Response" value={Math.round(m.p50ResponseTime ?? 0)} unit="ms" />
              </div>
              <div className="col-span-1 lg:col-span-3">
                <MetricCell label="p99 Response" value={Math.round(m.p99ResponseTime ?? 0)} unit="ms" />
              </div>
              {((m as any).errorBreakdown || (m.statusCodes && Object.keys(m.statusCodes as Record<string,number>).length > 0)) && (
                <div className="col-span-1 lg:col-span-3">
                  <BentoCard>
                    <div className="p-3">
                      <div className="text-[10px] font-mono font-semibold text-[#57606a] uppercase tracking-wide mb-2">Error Breakdown</div>
                      {(m as any).errorBreakdown ? (() => {
                        const eb = (m as any).errorBreakdown;
                        const total = eb.success + eb.clientError + eb.serverError + eb.timeout + eb.networkError;
                        const pct = (n: number) => total > 0 ? `${((n / total) * 100).toFixed(1)}%` : '0%';
                        const rows = [
                          { label: '✓ Success',    count: eb.success,      cls: 'text-[#1f883d]' },
                          { label: '⚠ Client 4xx', count: eb.clientError,  cls: 'text-[#9a6700]' },
                          { label: '✗ Server 5xx', count: eb.serverError,  cls: 'text-[#cf222e]' },
                          { label: '⏱ Timeout',    count: eb.timeout,      cls: 'text-[#cf222e]' },
                          { label: '✗ Network',    count: eb.networkError, cls: 'text-[#cf222e]' },
                        ];
                        return (
                          <div className="space-y-0.5">
                            {rows.filter(r => r.count > 0 || r.label.includes('Success')).map(r => (
                              <div key={r.label} className="flex items-center justify-between text-[11px] font-mono">
                                <span className={r.cls}>{r.label}</span>
                                <span className="text-[#57606a]">{r.count.toLocaleString()} <span className="text-[#8c959f]">({pct(r.count)})</span></span>
                              </div>
                            ))}
                          </div>
                        );
                      })() : (
                        <div className="space-y-0.5">
                          {Object.entries(m.statusCodes as Record<string,number>).sort().map(([code, count]) => (
                            <div key={code} className="flex items-center justify-between text-[12px] font-mono">
                              <span className={code.startsWith('2') ? 'text-[#1f883d]' : code.startsWith('4') || code.startsWith('5') ? 'text-[#cf222e]' : 'text-[#57606a]'}>{code}</span>
                              <span className="text-[#57606a]">×{count}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {(m as any).errorBreakdown && m.statusCodes && Object.keys(m.statusCodes as Record<string,number>).length > 0 && (
                        <details className="mt-2">
                          <summary className="text-[10px] text-[#8c959f] cursor-pointer hover:text-[#57606a]">Raw status codes</summary>
                          <div className="space-y-0.5 mt-1">
                            {Object.entries(m.statusCodes as Record<string,number>).sort().map(([code, count]) => (
                              <div key={code} className="flex items-center justify-between text-[11px] font-mono">
                                <span className={code.startsWith('2') ? 'text-[#1f883d]' : 'text-[#cf222e]'}>{code}</span>
                                <span className="text-[#8c959f]">×{count}</span>
                              </div>
                            ))}
                          </div>
                        </details>
                      )}
                    </div>
                  </BentoCard>
                </div>
              )}
            </>
          )}

          {/* ── Chart + Analysis side by side ── */}
          <div className="col-span-full lg:col-span-7">
            <BentoCard>
              <CardHeader title={isBackend ? 'Response Distribution' : 'Web Vitals'} />
              <div className="p-3">
                {result.type === 'flow' && (m as any).stepMetrics?.length > 0
                  ? <FlowStepChart steps={(m as any).stepMetrics} />
                  : isBackend
                    ? <BackendChart metrics={m as any} />
                    : <ClientChart metrics={m as any} />
                }
              </div>
            </BentoCard>
          </div>

          {result.analysis && (
            <div className="col-span-full lg:col-span-5">
              <BentoCard>
                <CardHeader title="Analysis" />
                <div className="p-3">
                  <AnalysisPanel analysis={result.analysis as any} />
                </div>
              </BentoCard>
            </div>
          )}

          {/* ── Per-step table (flow) ── */}
          {(m as any).stepMetrics?.length > 0 && (
            <StepMetricsTable steps={(m as any).stepMetrics} />
          )}

          {/* ── Trend chart ── */}
          {trend.length > 1 && (
            <div className="col-span-full">
              <BentoCard>
                <CardHeader title={`Trend — ${trend.length} runs for this URL`} />
                <div className="p-3">
                  <TrendChart
                    trend={trend}
                    metricKey={isBackend ? 'p95ResponseTime' : 'lcp'}
                    label={isBackend ? 'p95 (ms)' : 'LCP (ms)'}
                  />
                </div>
              </BentoCard>
            </div>
          )}

          {/* ── Generated script ── */}
          {result.script && (
            <div className="col-span-full">
              <BentoCard>
                <div className="px-3 py-2 border-b border-[#d0d7de] bg-[#f6f8fa] flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-[#57606a] uppercase tracking-wide">Generated Script</span>
                  <button
                    type="button"
                    onClick={() => {
                      const blob = new Blob([result.script!], { type: 'text/javascript' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `script-${testId.slice(0, 8)}.js`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                    className="text-[11px] font-mono text-[#0969da] hover:underline"
                  >
                    ↓ Download .js
                  </button>
                </div>
                <pre className="text-[11px] font-mono text-[#57606a] bg-[#f6f8fa] p-4 overflow-auto max-h-64 leading-relaxed">
                  {result.script}
                </pre>
              </BentoCard>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
