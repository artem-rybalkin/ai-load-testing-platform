import { useEffect, useRef, useState, lazy, Suspense } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getResult, getLiveMetrics, getTrend, setBaseline, clearBaseline, cancelTest, getLogSources, diagnoseErrors, getTrendNarrative, getExecutionLog, interpolateLogSourceUrl, LiveMetricPoint, TestResult, TrendPoint, LogSource, ErrorDiagnosis } from '@/lib/api';
import { useResultsSocket } from '@/lib/useResultsSocket';
const BackendChart  = lazy(() => import('@/app/components/BackendChart'));
const ClientChart   = lazy(() => import('@/app/components/ClientChart'));
const FlowStepChart = lazy(() => import('@/app/components/FlowStepChart'));
const AnalysisPanel = lazy(() => import('@/app/components/AnalysisPanel'));
const RealtimeChart = lazy(() => import('@/app/components/RealtimeChart'));
const TrendChart    = lazy(() => import('@/app/components/TrendChart'));

interface StepMetric { name: string; avgResponseTime: number; p95ResponseTime: number; requestsTotal: number; requestsFailed: number }

const fmtRemaining = (secs: number) => {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
};

const STATUS_BADGE_CLS: Record<string, string> = {
  completed: 'bg-green-bg text-green-fg-2',
  running:   'bg-orange-bg text-accent',
  pending:   'bg-amber-bg text-amber-badge-fg',
  failed:    'bg-red-bg text-red-badge-fg',
  cancelled: 'bg-surface-2 text-tx-3',
};
const StatusBadge = ({ status }: { status: string }) => (
  <span className={`px-2.75 py-1 rounded-chip text-[11px] font-bold font-mono uppercase ${STATUS_BADGE_CLS[status] ?? 'bg-surface-2 text-tx-3'}`}>
    {status === 'completed' ? 'passed' : status}
  </span>
);

const Card = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => (
  <div className={`bg-surface border border-border rounded-card overflow-hidden ${className}`}>{children}</div>
);

const CardHeader = ({ title, action }: { title: string; action?: React.ReactNode }) => (
  <div className="px-6 py-4 border-b border-border flex items-center justify-between gap-3 flex-wrap">
    <span className="font-display text-[16px] font-semibold">{title}</span>
    {action}
  </div>
);

const MetricCell = ({ label, value, unit, color }: { label: string; value: number | string; unit?: string; color?: string }) => (
  <Card>
    <div className="px-4.5 py-4">
      <div className="font-mono text-[10px] tracking-[0.08em] text-tx-4 uppercase">{label}</div>
      <div className={`font-display text-[28px] font-bold leading-none mt-1.75 ${color ?? ''}`}>
        {value}
        {unit && <span className="text-[14px] font-normal text-tx-4 ml-1">{unit}</span>}
      </div>
    </div>
  </Card>
);

const StepMetricsTable = ({ steps }: { steps: StepMetric[] }) => (
  <Card className="col-span-full">
    <CardHeader title="Per-step breakdown" />
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="bg-surface-2 border-b border-border">
            {['Step', 'Requests', 'Failed', 'Avg ms', 'p95 ms'].map(h => (
              <th key={h} className={`py-3 px-6 font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase ${h === 'Step' ? 'text-left' : 'text-right'}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border-3">
          {steps.map((s, i) => (
            <tr key={i} className="hover:bg-hover">
              <td className="py-3 px-6 text-[13.5px] font-medium">{s.name}</td>
              <td className="py-3 px-6 text-right font-mono text-[12.5px] text-tx-3">{s.requestsTotal}</td>
              <td className={`py-3 px-6 text-right font-mono text-[12.5px] ${s.requestsFailed > 0 ? 'text-red-fg font-semibold' : 'text-tx-4'}`}>{s.requestsFailed}</td>
              <td className="py-3 px-6 text-right font-mono text-[12.5px] text-tx-3">{Math.round(s.avgResponseTime)}</td>
              <td className={`py-3 px-6 text-right font-mono text-[12.5px] font-semibold ${s.p95ResponseTime > 1000 ? 'text-red-fg' : s.p95ResponseTime > 500 ? 'text-amber-fg' : 'text-green-fg'}`}>
                {Math.round(s.p95ResponseTime)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </Card>
);

type LogLevel = 'ALL' | 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

const LEVEL_COLOR: Record<string, string> = {
  ERROR: 'text-red-fg',
  WARN:  'text-amber-fg',
  DEBUG: 'text-tx-4',
  INFO:  'text-tx',
};

interface LogEntry { level: string; line: string; seq: number }

const parseEntry = (raw: string, seq: number): LogEntry => {
  const m = raw.match(/^\[(INFO|WARN|ERROR|DEBUG)\] ([\s\S]*)$/);
  return m ? { level: m[1], line: m[2], seq } : { level: 'INFO', line: raw, seq };
};

function ExecutionLogPanel({
  testId, isRunning, liveLines,
}: { testId: string; isRunning: boolean; liveLines: LogEntry[] }) {
  const [open, setOpen]       = useState(false);
  const [stored, setStored]   = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter]   = useState<LogLevel>('ALL');
  const scrollRef = useRef<HTMLPreElement>(null);
  const autoScroll = useRef(true);

  useEffect(() => {
    if (!open || isRunning || stored !== null) return;
    setLoading(true);
    getExecutionLog(testId)
      .then(d => setStored(d.log ?? ''))
      .catch(() => setStored(''))
      .finally(() => setLoading(false));
  }, [open, isRunning, testId, stored]);

  useEffect(() => {
    if (open && isRunning && autoScroll.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [liveLines, open, isRunning]);

  const allEntries: LogEntry[] = isRunning
    ? liveLines
    : (stored ?? '').split('\n').filter(Boolean).map((s, i) => parseEntry(s, i));

  const visible = filter === 'ALL'
    ? allEntries
    : allEntries.filter(e => e.level === filter);

  const rawText = allEntries.map(e => `[${e.level}] ${e.line}`).join('\n');

  const download = (): void => {
    const blob = new Blob([rawText], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `test-${testId.slice(0, 8)}-log.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copy = (): void => { navigator.clipboard.writeText(rawText).catch(() => {}); };

  const counts = allEntries.reduce<Record<string, number>>((acc, e) => {
    acc[e.level] = (acc[e.level] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <Card className="col-span-full">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-6 py-4 hover:bg-hover transition-colors"
      >
        <span className="font-display text-[16px] font-semibold flex items-center gap-2">
          Execution Log
          {isRunning && liveLines.length > 0 && <span className="text-accent text-[10px] font-mono pulse-dot">● LIVE</span>}
          {!isRunning && allEntries.length > 0 && <span className="text-tx-4 font-mono text-[11px] font-normal">{allEntries.length} lines</span>}
        </span>
        <span className="text-[11px] text-tx-4">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div>
          <div className="flex items-center gap-1.5 px-6 py-2.5 border-t border-border bg-surface-2 flex-wrap">
            {(['ALL', 'INFO', 'WARN', 'ERROR', 'DEBUG'] as LogLevel[]).map(lvl => (
              <button
                key={lvl}
                type="button"
                onClick={() => setFilter(lvl)}
                className={`px-2.5 py-0.75 text-[11px] font-mono rounded-chip border transition-colors ${
                  filter === lvl ? 'bg-sel border-sel text-white' : 'bg-surface border-border text-tx-3 hover:bg-hover'
                }`}
              >
                {lvl}{lvl !== 'ALL' && counts[lvl] ? ` (${counts[lvl]})` : ''}
              </button>
            ))}
            <span className="ml-auto flex gap-1.5">
              <button type="button" onClick={copy} className="px-2.5 py-0.75 text-[11px] font-mono rounded-chip border border-border bg-surface text-tx-3 hover:bg-hover">Copy</button>
              <button type="button" onClick={download} className="px-2.5 py-0.75 text-[11px] font-mono rounded-chip border border-border bg-surface text-tx-3 hover:bg-hover">↓ Download</button>
            </span>
          </div>

          {loading ? (
            <div className="px-6 py-4 text-[12px] font-mono text-tx-4">Loading…</div>
          ) : (
            <pre
              ref={scrollRef}
              onScroll={() => {
                if (!scrollRef.current) return;
                const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
                autoScroll.current = scrollHeight - scrollTop - clientHeight < 40;
              }}
              className="px-6 py-3 text-[11px] font-mono overflow-x-auto overflow-y-auto max-h-[400px] leading-relaxed bg-surface-2 whitespace-pre-wrap break-all"
            >
              {visible.length === 0 ? (
                <span className="text-tx-4">
                  {allEntries.length === 0
                    ? (isRunning ? 'Waiting for log output…' : 'No execution log recorded.')
                    : `No ${filter} entries.`}
                </span>
              ) : (
                visible.map((e) => (
                  <div key={e.seq} className={LEVEL_COLOR[e.level] ?? 'text-tx'}>
                    <span className="select-none text-tx-4">[{e.level.padEnd(5)}] </span>
                    {e.line}
                  </div>
                ))
              )}
            </pre>
          )}
        </div>
      )}
    </Card>
  );
}

export default function ResultPage() {
  const { testId } = useParams() as { testId: string };
  const [result, setResult] = useState<TestResult | null>(null);
  const resultRef = useRef<TestResult | null>(null);
  const [livePoints, setLivePoints] = useState<LiveMetricPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [baselineBusy, setBaselineBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [remainingSecs, setRemainingSecs] = useState<number | null>(null);
  const [elapsedSecs, setElapsedSecs] = useState<number | null>(null);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [logSources, setLogSources] = useState<LogSource[]>([]);
  const [diagnoses, setDiagnoses] = useState<ErrorDiagnosis[] | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnoseError, setDiagnoseError] = useState<string | null>(null);
  const [trendNarrative, setTrendNarrative] = useState<string | null>(null);
  const [trendNarrativeLoading, setTrendNarrativeLoading] = useState(false);
  const [liveLogLines, setLiveLogLines] = useState<LogEntry[]>([]);

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

  // Elapsed timer — increments every second once started_at is known
  useEffect(() => {
    if (result?.status !== 'running' || !result.started_at) { setElapsedSecs(null); return; }
    const tick = () => setElapsedSecs(Math.floor((Date.now() - new Date(result.started_at!).getTime()) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [result?.status, result?.started_at]);

  // Keep ref in sync so WS callbacks always see the latest result without stale closure
  useEffect(() => { resultRef.current = result; }, [result]);

  // Fallback re-sync — while a test is in-flight, periodically re-fetch.
  // WebSocket push is the primary update path, but some status transitions
  // (e.g. a worker writing 'failed' without going through results-service's
  // REST layer) never broadcast a test:status event, leaving an open page
  // stuck on a stale 'pending'/'running' view indefinitely. A low-frequency
  // poll self-heals within ~20s instead of requiring a manual reload.
  useEffect(() => {
    if (result?.status !== 'pending' && result?.status !== 'running') return;
    const id = setInterval(() => {
      getResult(testId).then(d => { if (d.result) setResult(d.result); }).catch(() => {});
    }, 20_000);
    return () => clearInterval(id);
  }, [result?.status, testId]);

  // Initial data load
  useEffect(() => {
    const load = async () => {
      try {
        const data = await getResult(testId);
        if (data.result) {
          setResult(data.result);
          resultRef.current = data.result;
          if (data.result.status === 'completed') {
            getTrend(data.result.target_url).then(d => setTrend(d.trend ?? [])).catch(() => {});
          }
        }
      } catch { /* ignore */ } finally { setLoading(false); }
    };
    load();
    getLogSources().then(d => setLogSources(d.logSources ?? [])).catch(() => {});

    // Load any existing live points (for in-progress or completed tests)
    getLiveMetrics(testId).then(d => setLivePoints(d.points ?? [])).catch(() => {});
  }, [testId]);

  // WebSocket push — replaces the 2s polling loops for status and live metrics
  useResultsSocket((event) => {
    if (event.type === 'reconnected') {
      // Re-sync after a dropped connection — re-fetch state and any missed live points
      getResult(testId).then(d => { if (d.result) setResult(d.result); }).catch(() => {});
      getLiveMetrics(testId).then(d => setLivePoints(d.points ?? [])).catch(() => {});
      return;
    }
    if (event.type === 'test:status' && event.testId === testId) {
      const isCompleted = event.status === 'completed';
      setResult(prev => {
        if (!prev) return prev;
        // Clear status_message when transitioning to running/cancelled/failed —
        // the backend clears it in the DB at that point; without this the stale
        // AI-generation message would linger in local state indefinitely.
        const clearMsg = ['running', 'cancelled', 'failed'].includes(event.status);
        return {
          ...prev,
          status: event.status,
          perf_status: event.perfStatus ?? prev.perf_status,
          ...(clearMsg ? { status_message: null } : {}),
        };
      });
      if (event.status === 'running') {
        // Fetch to populate started_at so the countdown/elapsed timer can start.
        // The optimistic setResult above only carries status fields, not timestamps.
        getResult(testId).then(d => { if (d.result) setResult(d.result); }).catch(() => {});
      }
      if (isCompleted) {
        // Fetch full result to get metrics + analysis populated by consumer.
        // Done outside the updater so React Strict Mode double-invocation
        // (dev only) doesn't fire two network requests per event.
        getResult(testId).then(d => { if (d.result) setResult(d.result); }).catch(() => {});
        // Use ref so we always have the latest target_url even if state is stale
        const url = resultRef.current?.target_url;
        if (url) getTrend(url).then(d => setTrend(d.trend ?? [])).catch(() => {});
      }
    }
    if (event.type === 'test:live' && event.testId === testId) {
      // Cap at 120 points (~4 minutes of 2s windows) to bound memory growth
      setLivePoints(prev => [...prev, event.point].slice(-120));
      // Receiving live data while still showing 'pending' means the test:status:running
      // event was broadcast before the WS connection was fully established — catch up.
      if (resultRef.current?.status === 'pending') {
        getResult(testId).then(d => { if (d.result) setResult(d.result); }).catch(() => {});
      }
    }
    if (event.type === 'test:log' && event.testId === testId) {
      setLiveLogLines(prev => {
        const next = [...prev, { level: event.level, line: event.line, seq: prev.length }];
        return next.slice(-5000);
      });
    }
  });

  if (loading) return (
    <div className="flex items-center justify-center h-40 text-tx-4 text-[13px]">Loading…</div>
  );

  if (!result) return (
    <div className="flex items-center justify-center h-48">
      <div className="text-center">
        <div className="animate-spin w-6 h-6 border-2 border-accent border-t-transparent rounded-full mx-auto mb-3" />
        <p className="font-medium text-[13px] mb-1">Generating test script…</p>
        <p className="text-tx-4 text-[11px] mb-4">This usually takes 10–30 seconds</p>
        <div className="flex gap-2 justify-center">
          <Link to="/" className="px-3.5 py-2 bg-accent text-white rounded-control text-[12.5px] font-semibold">+ New test</Link>
          <Link to="/results" className="px-3.5 py-2 border border-border rounded-control text-[12.5px]">All results</Link>
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
    <div>
      <div className="px-4 md:px-9 pt-6.5">
        <Link to="/results" className="inline-flex items-center gap-1.5 text-[13px] text-tx-4 hover:text-tx mb-3.5">← Results</Link>
        <div className="flex items-start justify-between gap-3.5 flex-wrap">
          <div>
            <div className="flex items-center gap-3 flex-wrap">
              <span className="font-display text-[clamp(22px,5.5vw,30px)] font-bold tracking-[-0.02em] font-mono break-all">{result.target_url}</span>
              <StatusBadge status={result.status} />
              {result.reused_script && <span className="font-mono text-[11px] text-purple-fg bg-purple-bg border border-purple-bd rounded-chip px-2.25 py-0.75">script reused</span>}
              {result.is_baseline && <span className="font-mono text-[11px] text-amber-badge-fg bg-amber-bg rounded-chip px-2.25 py-0.75">baseline</span>}
            </div>
            <div className="font-mono text-[12.5px] text-tx-4 mt-2">
              {result.duration_seconds ? `${result.duration_seconds}s` : ''}{result.status === 'completed' ? ' · finished' : ''} {result.completed_at ? new Date(result.completed_at).toLocaleString() : ''}
            </div>
          </div>
          <div className="flex items-center gap-2.5 flex-wrap">
            {(isPending || isRunning) && (
              <button onClick={handleCancel} disabled={cancelling} className="px-3.5 py-2 rounded-control text-[12.5px] font-semibold border border-red-fg/30 text-red-fg hover:bg-red-bg disabled:opacity-50 transition-colors">
                {cancelling ? 'Cancelling…' : 'Cancel'}
              </button>
            )}
            {result.status === 'completed' && (
              <>
                <button onClick={handleBaseline} disabled={baselineBusy}
                  className={`px-3.5 py-2 rounded-control text-[12.5px] font-semibold border transition-colors disabled:opacity-50 ${
                    result.is_baseline ? 'border-amber-fg/40 text-amber-badge-fg hover:bg-amber-bg' : 'border-border bg-surface text-tx-2 hover:border-tx'
                  }`}>
                  {result.is_baseline ? 'Clear baseline' : 'Set baseline'}
                </button>
                <a href={`${import.meta.env.VITE_RESULTS_URL || 'http://localhost:3004'}/results/${testId}/report.pdf`} target="_blank" rel="noreferrer"
                  className="px-3.5 py-2 rounded-control text-[12.5px] font-semibold border border-border bg-surface text-tx-2 hover:border-tx transition-colors">↓ PDF</a>
                <a href={`${import.meta.env.VITE_RESULTS_URL || 'http://localhost:3004'}/results/${testId}/report.csv`} target="_blank" rel="noreferrer"
                  className="px-3.5 py-2 rounded-control text-[12.5px] font-semibold border border-border bg-surface text-tx-2 hover:border-tx transition-colors">↓ CSV</a>
                <Link to={`/?rerun=${testId}`} className="flex items-center gap-1.5 bg-btn2 text-white rounded-control px-4 py-2 text-[13px] font-semibold">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 2a6 6 0 1 0 5.2 3" stroke="var(--accent)" strokeWidth="1.6" /><path d="M13 1v4h-4" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg> Re-run
                </Link>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="px-4 md:px-9 py-6 flex flex-col gap-5">

        {/* Progress bar / elapsed bar (running) */}
        {isRunning && (result.started_at || result.duration_seconds) && (
          <div className="flex items-center gap-3.5 bg-surface border border-border rounded-card px-5 py-3">
            <span className="flex items-center gap-1.5 font-mono text-[11px] text-accent font-bold whitespace-nowrap">
              <span className="w-1.5 h-1.5 bg-accent rounded-full pulse-dot" /> LIVE
            </span>
            {result.duration_seconds && remainingSecs !== null ? (
              <>
                <div className="flex-1 h-1.5 bg-line rounded-full overflow-hidden">
                  <div className="h-full bg-accent rounded-full transition-all duration-1000" style={{ width: `${pct}%` }} />
                </div>
                <span className="font-mono text-[11px] text-tx-3 whitespace-nowrap">{remainingSecs <= 0 ? 'finishing…' : `${fmtRemaining(remainingSecs)} left`}</span>
              </>
            ) : elapsedSecs !== null ? (
              <>
                <div className="flex-1" />
                <span className="font-mono text-[11px] text-tx-3 whitespace-nowrap">{fmtRemaining(elapsedSecs)} elapsed</span>
              </>
            ) : null}
          </div>
        )}

        {/* Live chart — shown while running (before metrics arrive) and after completion */}
        {isBackend && livePoints.length > 0 && (isPending || !m) && (
          <Card>
            <CardHeader title={isRunning ? 'Live Metrics' : 'Test Timeline'} />
            <div className="p-5"><Suspense fallback={null}><RealtimeChart points={livePoints} startedAt={result.started_at} /></Suspense></div>
          </Card>
        )}

        {/* Pending / running / terminal-no-metrics / completed-loading state */}
        {(isPending || isRunning || !m) ? (
          <Card>
            <div className="p-10 text-center">
              {isTerminal ? (
                <p className="text-tx-4 text-[13px]">Test {result.status} — no metrics collected.</p>
              ) : result.status === 'completed' ? (
                <div className="animate-pulse"><p className="text-tx-4 text-[13px]">Loading results…</p></div>
              ) : isPending ? (
                <div className="animate-pulse">
                  <p className="text-tx-4 text-[13px]">Waiting in queue…</p>
                  <p className="text-tx-5 text-[11px] mt-1">AI is generating the test script</p>
                </div>
              ) : !isBackend ? (
                <div>
                  <div className="animate-spin w-5 h-5 border-2 border-accent border-t-transparent rounded-full mx-auto mb-3" />
                  <p className="font-semibold text-[13px] mb-1">Running browser test…</p>
                  <p className="text-tx-4 text-[11px] mb-3">Collecting Core Web Vitals · Lighthouse audit · Web page resources</p>
                  {elapsedSecs !== null && (
                    <div className="inline-flex items-center gap-2 bg-bg border border-border rounded-control px-3.5 py-2 text-[12px] font-mono">
                      <span className="text-tx-4">Elapsed</span>
                      <span className="text-accent font-semibold">{fmtRemaining(elapsedSecs)}</span>
                      {remainingSecs !== null && remainingSecs > 0 && (<><span className="text-border">·</span><span className="text-tx-4">{fmtRemaining(remainingSecs)} left</span></>)}
                    </div>
                  )}
                </div>
              ) : (
                <div className="animate-pulse">
                  <p className="text-tx-4 text-[13px]">Test is running…</p>
                  <p className="text-tx-5 text-[11px] mt-1">{elapsedSecs !== null ? `${fmtRemaining(elapsedSecs)} elapsed` : 'Page updates in real time'}</p>
                </div>
              )}
              {!isTerminal && result.status_message && (
                <p className={`text-[11px] font-mono mt-3 ${
                  result.status_message.includes('failed') || result.status_message.includes('unavailable') ? 'text-amber-badge-fg'
                    : result.status_message.includes('ready') || result.status_message.includes('starting') ? 'text-green-fg-2' : 'text-tx-4'
                }`}>{result.status_message}</p>
              )}
              {!isTerminal && remainingSecs !== null && (
                <div className="mt-4 max-w-xs mx-auto">
                  <p className="text-[12px] font-mono text-accent mb-2">{remainingSecs <= 0 ? 'finishing…' : `${fmtRemaining(remainingSecs)} remaining`}</p>
                  {result.duration_seconds && (
                    <div className="h-1.5 bg-line rounded-full overflow-hidden"><div className="h-full bg-accent rounded-full transition-all duration-1000" style={{ width: `${pct}%` }} /></div>
                  )}
                </div>
              )}
            </div>
          </Card>
        ) : (
          <div className="flex flex-col gap-5">

            {/* Metric cells */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3.5">
              {isBackend ? (
                <>
                  <MetricCell label="Total Requests" value={m.requestsTotal} />
                  <MetricCell label="Req / sec" value={(m.rps ?? 0).toFixed(1)} color="text-accent" />
                  <MetricCell label="Failed" value={m.requestsFailed} unit={`/ ${m.requestsTotal > 0 ? ((m.requestsFailed / m.requestsTotal) * 100).toFixed(1) : 0}%`} color={m.requestsFailed > 0 ? 'text-red-fg' : ''} />
                  <MetricCell label="p95 Response" value={Math.round(m.p95ResponseTime ?? 0)} unit="ms" />
                  <MetricCell label="Avg Response" value={Math.round(m.avgResponseTime ?? 0)} unit="ms" />
                  <MetricCell label="p99 Response" value={Math.round(m.p99ResponseTime ?? 0)} unit="ms" />
                </>
              ) : (
                <>
                  <MetricCell label="LCP" value={Math.round(m.lcp ?? 0)} unit="ms" color={(m.lcp ?? 0) > 2500 ? 'text-red-fg' : 'text-green-fg'} />
                  <MetricCell label="FCP" value={Math.round(m.fcp ?? 0)} unit="ms" />
                  <MetricCell label="TTFB" value={Math.round(m.ttfb ?? 0)} unit="ms" />
                  <MetricCell label="CLS" value={(m.cls ?? 0).toFixed(3)} color={(m.cls ?? 0) > 0.1 ? 'text-red-fg' : 'text-green-fg'} />
                </>
              )}
            </div>

            {/* Live / timeline chart */}
            {isBackend && livePoints.length > 0 && (
              <Card>
                <CardHeader title="Test Timeline" />
                <div className="p-5"><Suspense fallback={null}><RealtimeChart points={livePoints} startedAt={result.started_at} /></Suspense></div>
              </Card>
            )}

            <div className="grid grid-cols-1 lg:[grid-template-columns:minmax(320px,7fr)_minmax(280px,5fr)] gap-5">
              <Card>
                <CardHeader title={isBackend ? 'Response Distribution' : 'Web Vitals'} />
                <div className="p-5">
                  <Suspense fallback={null}>
                    {result.type === 'flow' && (m as any).stepMetrics?.length > 0
                      ? <FlowStepChart steps={(m as any).stepMetrics} />
                      : isBackend ? <BackendChart metrics={m as any} /> : <ClientChart metrics={m as any} />}
                  </Suspense>
                </div>
              </Card>

              {result.analysis && (
                <Card>
                  <CardHeader title="Analysis" />
                  <div className="p-5"><Suspense fallback={null}><AnalysisPanel analysis={result.analysis as any} /></Suspense></div>
                </Card>
              )}
            </div>

            {/* Error breakdown + AI diagnose */}
            {isBackend && ((m as any).errorBreakdown || (m.statusCodes && Object.keys(m.statusCodes as Record<string,number>).length > 0)) && (
              <Card>
                <CardHeader title="Error Breakdown" />
                <div className="p-5">
                  {(m as any).errorBreakdown ? (() => {
                    const eb = (m as any).errorBreakdown;
                    const total = eb.success + eb.clientError + eb.serverError + eb.timeout + eb.networkError;
                    const pctOf = (n: number) => total > 0 ? `${((n / total) * 100).toFixed(1)}%` : '0%';
                    const rows = [
                      { label: '✓ Success',    count: eb.success,      cls: 'text-green-fg' },
                      { label: '⚠ Client 4xx', count: eb.clientError,  cls: 'text-amber-fg' },
                      { label: '✗ Server 5xx', count: eb.serverError,  cls: 'text-red-fg' },
                      { label: '⏱ Timeout',    count: eb.timeout,      cls: 'text-red-fg' },
                      { label: '✗ Network',    count: eb.networkError, cls: 'text-red-fg' },
                    ];
                    return (
                      <div className="space-y-1">
                        {rows.filter(r => r.count > 0 || r.label.includes('Success')).map(r => (
                          <div key={r.label} className="flex items-center justify-between text-[12px] font-mono">
                            <span className={r.cls}>{r.label}</span>
                            <span className="text-tx-3">{r.count.toLocaleString()} <span className="text-tx-4">({pctOf(r.count)})</span></span>
                          </div>
                        ))}
                      </div>
                    );
                  })() : (
                    <div className="space-y-1">
                      {Object.entries(m.statusCodes as Record<string,number>).sort().map(([code, count]) => (
                        <div key={code} className="flex items-center justify-between text-[12.5px] font-mono">
                          <span className={code.startsWith('2') ? 'text-green-fg' : code.startsWith('4') || code.startsWith('5') ? 'text-red-fg' : 'text-tx-3'}>{code}</span>
                          <span className="text-tx-3">×{count}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {(m as any).errorBreakdown && m.statusCodes && Object.keys(m.statusCodes as Record<string,number>).length > 0 && (
                    <details className="mt-2.5">
                      <summary className="text-[11px] text-tx-4 cursor-pointer hover:text-tx-2">Raw status codes</summary>
                      <div className="space-y-1 mt-1.5">
                        {Object.entries(m.statusCodes as Record<string,number>).sort().map(([code, count]) => (
                          <div key={code} className="flex items-center justify-between text-[12px] font-mono">
                            <span className={code.startsWith('2') ? 'text-green-fg' : 'text-red-fg'}>{code}</span>
                            <span className="text-tx-4">×{count}</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                  {(m as any).errorBreakdown && (
                    <div className="mt-3 pt-3 border-t border-line">
                      {diagnoses === null && (
                        <button type="button" disabled={diagnosing} className="text-[12.5px] text-accent hover:underline disabled:opacity-50 font-mono"
                          onClick={async () => {
                            setDiagnosing(true); setDiagnoseError(null);
                            try { const r = await diagnoseErrors(testId!); setDiagnoses(r.diagnoses); }
                            catch (e) { setDiagnoseError((e as Error).message); }
                            finally { setDiagnosing(false); }
                          }}>
                          {diagnosing ? '⏳ Diagnosing…' : '✨ Diagnose with AI'}
                        </button>
                      )}
                      {diagnoseError && <p className="text-[11px] text-red-fg font-mono mt-1">{diagnoseError}</p>}
                      {diagnoses && diagnoses.length > 0 && (
                        <div className="mt-2 space-y-2">
                          {diagnoses.map((d, i) => (
                            <div key={i} className="p-2.5 bg-amber-bg border border-amber-fg/25 rounded-control text-[11.5px]">
                              <div className="font-semibold text-amber-badge-fg font-mono">{d.category} ×{d.count}</div>
                              <div className="text-tx-3 mt-0.5">⚠ {d.likelyCause}</div>
                              <div className="text-accent mt-0.5">→ {d.nextStep}</div>
                            </div>
                          ))}
                        </div>
                      )}
                      {diagnoses && diagnoses.length === 0 && <p className="text-[11px] text-tx-4 font-mono mt-1">No actionable diagnoses found.</p>}
                    </div>
                  )}
                </div>
              </Card>
            )}

            {(m as any).stepMetrics?.length > 0 && <StepMetricsTable steps={(m as any).stepMetrics} />}

            {trend.length > 1 && (
              <Card>
                <CardHeader title={`Trend — ${trend.length} runs for this URL`} />
                <div className="p-5">
                  <Suspense fallback={null}><TrendChart trend={trend} metricKey={isBackend ? 'p95ResponseTime' : 'lcp'} label={isBackend ? 'p95 (ms)' : 'LCP (ms)'} /></Suspense>
                </div>
                <div className="px-5 pb-5">
                  {trendNarrative ? (
                    <p className="text-[12.5px] text-tx-3 font-mono border-t border-line pt-3">{trendNarrative}</p>
                  ) : (
                    <button type="button" disabled={trendNarrativeLoading} className="text-[12.5px] text-accent hover:underline disabled:opacity-50 font-mono"
                      onClick={async () => {
                        setTrendNarrativeLoading(true);
                        try { const { narrative } = await getTrendNarrative(trend); setTrendNarrative(narrative); }
                        catch { setTrendNarrative('Could not generate narrative.'); }
                        finally { setTrendNarrativeLoading(false); }
                      }}>
                      {trendNarrativeLoading ? '⏳ Analysing trend…' : '✨ Summarise trend'}
                    </button>
                  )}
                </div>
              </Card>
            )}

            {logSources.length > 0 && result.started_at && (
              <Card>
                <CardHeader title="External Logs" />
                <div className="px-5 py-4 flex flex-wrap gap-2.5">
                  {logSources.map(src => (
                    <a key={src.id} href={interpolateLogSourceUrl(src.url_template, result)} target="_blank" rel="noreferrer"
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 border border-border rounded-control text-[12.5px] font-medium hover:border-tx-5 transition-colors">
                      {src.platform && <span className="text-[10px] font-mono bg-orange-bg text-accent px-1.5 py-0.5 rounded-chip">{src.platform}</span>}
                      {src.name} →
                    </a>
                  ))}
                </div>
              </Card>
            )}

            {result.script && (
              <Card>
                <CardHeader title="Generated Script" action={
                  <button type="button" className="text-[11px] font-mono text-accent hover:underline"
                    onClick={() => {
                      const blob = new Blob([result.script!], { type: 'text/javascript' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url; a.download = `script-${testId.slice(0, 8)}.js`; a.click();
                      URL.revokeObjectURL(url);
                    }}>↓ Download .js</button>
                } />
                <pre className="text-[11px] font-mono text-tx-3 bg-surface-2 p-5 overflow-auto max-h-64 leading-relaxed">{result.script}</pre>
              </Card>
            )}

            <ExecutionLogPanel testId={testId} isRunning={false} liveLines={liveLogLines} />
          </div>
        )}

        {isRunning && <ExecutionLogPanel testId={testId} isRunning={true} liveLines={liveLogLines} />}
      </div>
    </div>
  );
}
