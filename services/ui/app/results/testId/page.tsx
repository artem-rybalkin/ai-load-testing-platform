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

type LogLevel = 'ALL' | 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

const LEVEL_COLOR: Record<string, string> = {
  ERROR: 'text-[#cf222e]',
  WARN:  'text-[#9a6700]',
  DEBUG: 'text-[#8c959f]',
  INFO:  'text-[#24292f]',
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
    <BentoCard className="col-span-full">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-2 border-b border-[#d0d7de] bg-[#f6f8fa] hover:bg-[#eaeef2] transition-colors"
      >
        <span className="text-[11px] font-semibold text-[#57606a] uppercase tracking-wide flex items-center gap-2">
          Execution Log
          {isRunning && liveLines.length > 0 && (
            <span className="text-[#0969da] animate-pulse text-[10px]">● LIVE</span>
          )}
          {!isRunning && allEntries.length > 0 && (
            <span className="text-[#8c959f] font-normal normal-case">{allEntries.length} lines</span>
          )}
        </span>
        <span className="text-[11px] text-[#57606a]">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div>
          {/* Filter + action bar */}
          <div className="flex items-center gap-1.5 px-3 py-2 border-b border-[#eaeef2] bg-[#f6f8fa] flex-wrap">
            {(['ALL', 'INFO', 'WARN', 'ERROR', 'DEBUG'] as LogLevel[]).map(lvl => (
              <button
                key={lvl}
                type="button"
                onClick={() => setFilter(lvl)}
                className={`px-2 py-0.5 text-[11px] font-mono rounded border transition-colors ${
                  filter === lvl
                    ? 'bg-[#0969da] border-[#0969da] text-white'
                    : 'bg-white border-[#d0d7de] text-[#57606a] hover:bg-[#f6f8fa]'
                }`}
              >
                {lvl}{lvl !== 'ALL' && counts[lvl] ? ` (${counts[lvl]})` : ''}
              </button>
            ))}
            <span className="ml-auto flex gap-1.5">
              <button type="button" onClick={copy}     className="px-2 py-0.5 text-[11px] font-mono rounded border border-[#d0d7de] bg-white text-[#57606a] hover:bg-[#f6f8fa]">Copy</button>
              <button type="button" onClick={download} className="px-2 py-0.5 text-[11px] font-mono rounded border border-[#d0d7de] bg-white text-[#57606a] hover:bg-[#f6f8fa]">↓ Download</button>
            </span>
          </div>

          {/* Log output */}
          {loading ? (
            <div className="px-3 py-4 text-[12px] font-mono text-[#57606a]">Loading…</div>
          ) : (
            <pre
              ref={scrollRef}
              onScroll={() => {
                if (!scrollRef.current) return;
                const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
                autoScroll.current = scrollHeight - scrollTop - clientHeight < 40;
              }}
              className="px-3 py-2 text-[11px] font-mono overflow-x-auto overflow-y-auto max-h-[400px] leading-relaxed bg-[#f6f8fa] whitespace-pre-wrap break-all"
            >
              {visible.length === 0 ? (
                <span className="text-[#8c959f]">
                  {allEntries.length === 0
                    ? (isRunning ? 'Waiting for log output…' : 'No execution log recorded.')
                    : `No ${filter} entries.`}
                </span>
              ) : (
                visible.map((e) => (
                  <div key={e.seq} className={LEVEL_COLOR[e.level] ?? 'text-[#24292f]'}>
                    <span className="select-none text-[#8c959f]">[{e.level.padEnd(5)}] </span>
                    {e.line}
                  </div>
                ))
              )}
            </pre>
          )}
        </div>
      )}
    </BentoCard>
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
    <div className="flex items-center justify-center h-40 text-[#57606a] text-[13px]">Loading…</div>
  );

  if (!result) return (
    <div className="flex items-center justify-center h-48">
      <div className="text-center">
        <div className="animate-spin w-6 h-6 border-2 border-[#0969da] border-t-transparent rounded-full mx-auto mb-3" />
        <p className="text-[#24292f] font-medium text-[13px] mb-1">Generating test script…</p>
        <p className="text-[#57606a] text-[11px] mb-4">This usually takes 10–30 seconds</p>
        <div className="flex gap-2 justify-center">
          <Link to="/" className="px-3 py-1.5 bg-[#1f883d] text-white rounded-md text-[12px] font-medium">+ New test</Link>
          <Link to="/results" className="px-3 py-1.5 border border-[#d0d7de] text-[#24292f] rounded-md text-[12px]">All results</Link>
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
        <Link to="/results" className="text-[11px] text-[#57606a] hover:text-[#0969da] hover:underline">← All Results</Link>
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
                href={`${import.meta.env.VITE_RESULTS_URL || 'http://localhost:3004'}/results/${testId}/report.pdf`}
                target="_blank"
                rel="noreferrer"
                className="px-2.5 py-1 rounded-md text-[12px] font-medium border border-[#d0d7de] text-[#24292f] hover:bg-[#eaeef2] transition-colors"
              >
                ↓ PDF
              </a>
              <a
                href={`${import.meta.env.VITE_RESULTS_URL || 'http://localhost:3004'}/results/${testId}/report.csv`}
                target="_blank"
                rel="noreferrer"
                className="px-2.5 py-1 rounded-md text-[12px] font-medium border border-[#d0d7de] text-[#24292f] hover:bg-[#eaeef2] transition-colors"
              >
                ↓ CSV
              </a>
            </>
          )}
        </div>
      </div>

      {/* Progress bar / elapsed bar (running) */}
      {isRunning && (result.started_at || result.duration_seconds) && (
        <div className="flex items-center gap-3 mb-4 bg-white border border-[#d0d7de] rounded-md px-3 py-2">
          <span className="flex items-center gap-1.5 text-[11px] font-mono text-[#0969da] font-semibold whitespace-nowrap">
            <span className="w-1.5 h-1.5 bg-[#0969da] rounded-full animate-pulse" />
            LIVE
          </span>
          {result.duration_seconds && remainingSecs !== null ? (
            <>
              <div className="flex-1 h-1.5 bg-[#eaeef2] rounded-full overflow-hidden">
                <div className="h-full bg-[#0969da] rounded-full transition-all duration-1000" style={{ width: `${pct}%` }} />
              </div>
              <span className="text-[11px] font-mono text-[#57606a] whitespace-nowrap">
                {remainingSecs <= 0 ? 'finishing…' : `${fmtRemaining(remainingSecs)} left`}
              </span>
            </>
          ) : elapsedSecs !== null ? (
            <>
              <div className="flex-1" />
              <span className="text-[11px] font-mono text-[#57606a] whitespace-nowrap">
                {fmtRemaining(elapsedSecs)} elapsed
              </span>
            </>
          ) : null}
        </div>
      )}

      {/* Live chart — shown while running (before metrics arrive) and after completion */}
      {isBackend && livePoints.length > 0 && (isPending || !m) && (
        <BentoCard className="mb-3">
          <CardHeader title={isRunning ? 'Live Metrics' : 'Test Timeline'} />
          <div className="p-3">
            <Suspense fallback={null}><RealtimeChart points={livePoints} startedAt={result.started_at} /></Suspense>
          </div>
        </BentoCard>
      )}

      {/* Pending / running / terminal-no-metrics / completed-loading state */}
      {(isPending || isRunning || !m) ? (
        <BentoCard>
          <div className="p-8 text-center">
            {isTerminal ? (
              <p className="text-[#57606a] text-[13px]">
                Test {result.status} — no metrics collected.
              </p>
            ) : result.status === 'completed' ? (
              /* Brief window between WS 'completed' event and full refetch finishing */
              <div className="animate-pulse">
                <p className="text-[#57606a] text-[13px]">Loading results…</p>
              </div>
            ) : isPending ? (
              <div className="animate-pulse">
                <p className="text-[#57606a] text-[13px]">Waiting in queue…</p>
                <p className="text-[#8c959f] text-[11px] mt-1">AI is generating the test script</p>
              </div>
            ) : !isBackend ? (
              /* Browser test running — show elapsed + what's happening */
              <div>
                <div className="animate-spin w-5 h-5 border-2 border-[#0969da] border-t-transparent rounded-full mx-auto mb-3" />
                <p className="text-[#24292f] font-semibold text-[13px] mb-1">Running browser test…</p>
                <p className="text-[#57606a] text-[11px] mb-3">Collecting Core Web Vitals · Lighthouse audit · Web page resources</p>
                {elapsedSecs !== null && (
                  <div className="inline-flex items-center gap-2 bg-[#f6f8fa] border border-[#d0d7de] rounded px-3 py-1.5 text-[12px] font-mono">
                    <span className="text-[#57606a]">Elapsed</span>
                    <span className="text-[#0969da] font-semibold">{fmtRemaining(elapsedSecs)}</span>
                    {remainingSecs !== null && remainingSecs > 0 && (
                      <>
                        <span className="text-[#d0d7de]">·</span>
                        <span className="text-[#57606a]">{fmtRemaining(remainingSecs)} left</span>
                      </>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="animate-pulse">
                <p className="text-[#57606a] text-[13px]">Test is running…</p>
                <p className="text-[#8c959f] text-[11px] mt-1">
                  {elapsedSecs !== null ? `${fmtRemaining(elapsedSecs)} elapsed` : 'Page updates in real time'}
                </p>
              </div>
            )}
            {!isTerminal && result.status_message && (
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
                  <Suspense fallback={null}><RealtimeChart points={livePoints} startedAt={result.started_at} /></Suspense>
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

                    {/* AI-4: Error diagnosis button */}
                    {(m as any).errorBreakdown && (
                      <div className="px-3 pb-3">
                        {diagnoses === null && (
                          <button
                            type="button"
                            onClick={async () => {
                              setDiagnosing(true);
                              setDiagnoseError(null);
                              try {
                                const r = await diagnoseErrors(testId!);
                                setDiagnoses(r.diagnoses);
                              } catch (e) {
                                setDiagnoseError((e as Error).message);
                              } finally { setDiagnosing(false); }
                            }}
                            disabled={diagnosing}
                            className="text-[12px] text-[#0969da] hover:underline disabled:opacity-50 font-mono"
                          >
                            {diagnosing ? '⏳ Diagnosing…' : '✨ Diagnose with AI'}
                          </button>
                        )}
                        {diagnoseError && <p className="text-[11px] text-[#cf222e] font-mono mt-1">{diagnoseError}</p>}
                        {diagnoses && diagnoses.length > 0 && (
                          <div className="mt-2 space-y-2">
                            {diagnoses.map((d, i) => (
                              <div key={i} className="p-2 bg-[#fff8c5] border border-[#e3b34166] rounded text-[11px]">
                                <div className="font-semibold text-[#9a6700] font-mono">{d.category} ×{d.count}</div>
                                <div className="text-[#57606a] mt-0.5">⚠ {d.likelyCause}</div>
                                <div className="text-[#0969da] mt-0.5">→ {d.nextStep}</div>
                              </div>
                            ))}
                          </div>
                        )}
                        {diagnoses && diagnoses.length === 0 && (
                          <p className="text-[11px] text-[#57606a] font-mono mt-1">No actionable diagnoses found.</p>
                        )}
                      </div>
                    )}
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
                <Suspense fallback={null}>
                {result.type === 'flow' && (m as any).stepMetrics?.length > 0
                  ? <FlowStepChart steps={(m as any).stepMetrics} />
                  : isBackend
                    ? <BackendChart metrics={m as any} />
                    : <ClientChart metrics={m as any} />
                }
              </Suspense>
              </div>
            </BentoCard>
          </div>

          {result.analysis && (
            <div className="col-span-full lg:col-span-5">
              <BentoCard>
                <CardHeader title="Analysis" />
                <div className="p-3">
                  <Suspense fallback={null}><AnalysisPanel analysis={result.analysis as any} /></Suspense>
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
                  <Suspense fallback={null}><TrendChart
                    trend={trend}
                    metricKey={isBackend ? 'p95ResponseTime' : 'lcp'}
                    label={isBackend ? 'p95 (ms)' : 'LCP (ms)'}
                  /></Suspense>
                </div>
                {/* AI-7: Regression narrative */}
                <div className="px-3 pb-3">
                  {trendNarrative ? (
                    <p className="text-[12px] text-[#57606a] font-mono border-t border-[#eaeef2] pt-2">{trendNarrative}</p>
                  ) : (
                    <button type="button" disabled={trendNarrativeLoading}
                      onClick={async () => {
                        setTrendNarrativeLoading(true);
                        try {
                          const { narrative } = await getTrendNarrative(trend);
                          setTrendNarrative(narrative);
                        } catch { setTrendNarrative('Could not generate narrative.'); }
                        finally { setTrendNarrativeLoading(false); }
                      }}
                      className="text-[12px] text-[#0969da] hover:underline disabled:opacity-50 font-mono">
                      {trendNarrativeLoading ? '⏳ Analysing trend…' : '✨ Summarise trend'}
                    </button>
                  )}
                </div>
              </BentoCard>
            </div>
          )}

          {/* ── External log links ── */}
          {logSources.length > 0 && result.started_at && (
            <div className="col-span-full">
              <BentoCard>
                <CardHeader title="External Logs" />
                <div className="px-3 py-2.5 flex flex-wrap gap-2">
                  {logSources.map(src => (
                    <a
                      key={src.id}
                      href={interpolateLogSourceUrl(src.url_template, result)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-[#d0d7de] rounded-md text-[12px] text-[#24292f] hover:bg-[#eaeef2] hover:border-[#8c959f] transition-colors font-medium"
                    >
                      {src.platform && (
                        <span className="text-[10px] font-mono bg-[#ddf4ff] text-[#0969da] px-1 py-0.5 rounded">{src.platform}</span>
                      )}
                      {src.name} →
                    </a>
                  ))}
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

          {/* ── Execution log (completed) ── */}
          <ExecutionLogPanel testId={testId} isRunning={false} liveLines={liveLogLines} />
        </div>
      )}

      {/* ── Execution log (running) — shown below the running state card ── */}
      {isRunning && (
        <div className="mt-3">
          <ExecutionLogPanel testId={testId} isRunning={true} liveLines={liveLogLines} />
        </div>
      )}
    </div>
  );
}
