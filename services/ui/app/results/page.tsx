import { useEffect, useRef, useState } from 'react';
import { getResults, TestResult, BackendMetrics, ClientMetrics } from '@/lib/api';
import { useResultsSocket } from '@/lib/useResultsSocket';
import { useWorkspace } from '@/lib/WorkspaceContext';
import { Link, useNavigate } from 'react-router-dom';

function relTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const StatusDot = ({ status, perf }: { status: string; perf?: string }) => {
  const cls =
    perf === 'passed'  ? 'bg-status-pass' :
    perf === 'failed'  ? 'bg-status-fail' :
    perf === 'degraded'? 'bg-status-slow' :
    status === 'running' || status === 'pending' ? 'bg-live pulse-dot' :
    status === 'failed' || status === 'cancelled' ? 'bg-status-fail' :
    'bg-tx-5';
  return <span className={`w-2.25 h-2.25 rounded-full inline-block flex-shrink-0 ${cls}`} />;
};

const TYPE_CLS: Record<string, string> = {
  backend: 'text-accent bg-orange-bg border-orange-bd',
  flow: 'text-indigo-fg bg-indigo-bg border-indigo-bd',
  'client-side': 'text-purple-fg bg-purple-bg border-purple-bd',
};
const TYPE_LABEL: Record<string, string> = { backend: 'backend', 'client-side': 'browser', flow: 'flow' };

const TypeTag = ({ type }: { type: string }) => (
  <span className={`inline-block px-2 py-0.5 border rounded-chip text-[11px] font-mono ${TYPE_CLS[type] ?? TYPE_CLS.backend}`}>
    {TYPE_LABEL[type] ?? type}
  </span>
);

const STATUS_BADGE_CLS: Record<string, string> = {
  LIVE: 'text-green-fg-2 bg-green-bg',
  PASS: 'text-green-fg-2 bg-green-bg',
  SLOW: 'text-amber-badge-fg bg-amber-bg',
  FAIL: 'text-red-badge-fg bg-red-bg',
};

function statusBadge(r: TestResult): string {
  if (r.status === 'running' || r.status === 'pending') return 'LIVE';
  if (r.perf_status === 'passed') return 'PASS';
  if (r.perf_status === 'degraded') return 'SLOW';
  if (r.perf_status === 'failed') return 'FAIL';
  return r.status.toUpperCase();
}

function p95Value(r: TestResult): string {
  if (!r.metrics) return '—';
  if (r.type === 'client-side') {
    const cm = r.metrics as ClientMetrics;
    return cm.lcp != null ? `${Math.round(cm.lcp)}ms` : '—';
  }
  const bm = r.metrics as BackendMetrics;
  return bm.p95ResponseTime != null ? `${Math.round(bm.p95ResponseTime)}ms` : '—';
}

function errValue(r: TestResult): string {
  if (!r.metrics) return '—';
  if (r.type === 'client-side') {
    const cm = r.metrics as ClientMetrics;
    return cm.jsErrors != null ? `${cm.jsErrors} errs` : '—';
  }
  const { requestsTotal, requestsFailed } = r.metrics as BackendMetrics;
  if (!requestsTotal) return '—';
  return `${(((requestsFailed ?? 0) / requestsTotal) * 100).toFixed(2)}%`;
}

const DATE_RANGES = [
  { id: 'all', label: 'All time', days: null },
  { id: '1', label: 'Last 24 hours', days: 1 },
  { id: '7', label: 'Last 7 days', days: 7 },
  { id: '30', label: 'Last 30 days', days: 30 },
] as const;

export default function ResultsPage() {
  const { activeWorkspaceId } = useWorkspace();
  const [results, setResults] = useState<TestResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'backend' | 'client-side' | 'flow'>('all');
  const [dateRange, setDateRange] = useState<typeof DATE_RANGES[number]['id']>('all');
  const navigate = useNavigate();
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = async () => {
    const data = await getResults(undefined, 50, activeWorkspaceId);
    setResults(data.results || []);
    setNextBefore(data.nextBefore ?? null);
    setLoading(false);
  };

  const loadMore = async () => {
    if (!nextBefore || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await getResults(nextBefore, 50, activeWorkspaceId);
      setResults(prev => [...prev, ...(data.results || [])]);
      setNextBefore(data.nextBefore ?? null);
    } finally {
      setLoadingMore(false);
    }
  };

  // Reload when workspace filter changes
  useEffect(() => { setLoading(true); setResults([]); setNextBefore(null); refresh(); }, [activeWorkspaceId]);

  // Real-time updates via WebSocket — replaces 5s polling.
  // Debounced 50ms: consumer broadcasts both test:status + tests:changed together;
  // the debounce coalesces them into a single fetch.
  useResultsSocket((event) => {
    if (event.type === 'tests:changed' || event.type === 'test:status' || event.type === 'reconnected') {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(refresh, 50);
    }
  });

  const toggleSelect = (testId: string) => {
    setSelected(prev =>
      prev.includes(testId) ? prev.filter(id => id !== testId) : prev.length < 2 ? [...prev, testId] : [prev[1], testId]
    );
  };

  const rangeDays = DATE_RANGES.find(d => d.id === dateRange)?.days ?? null;
  const filtered = results.filter(r => {
    if (typeFilter !== 'all' && r.type !== typeFilter) return false;
    if (search && !r.target_url.toLowerCase().includes(search.toLowerCase())) return false;
    if (rangeDays !== null && Date.now() - new Date(r.created_at).getTime() > rangeDays * 86_400_000) return false;
    return true;
  });

  return (
    <div>
      <div className="px-4 md:px-9 pt-7.5 flex items-start justify-between flex-wrap gap-3.5">
        <div>
          <div className="font-mono text-[11px] tracking-[0.16em] text-accent uppercase mb-1.5">— History</div>
          <h1 className="font-display text-[clamp(26px,6.5vw,38px)] font-bold tracking-[-0.025em] leading-none">Results</h1>
        </div>
        <div className="flex items-center gap-2">
          {selected.length === 1 && <span className="text-[12.5px] text-tx-4">Select one more to compare</span>}
          {selected.length === 2 && (
            <button
              onClick={() => navigate(`/results/compare?a=${selected[0]}&b=${selected[1]}`)}
              className="border border-border bg-surface hover:bg-hover text-tx-2 rounded-control px-3.5 py-2 text-[12.5px] font-medium transition-colors"
            >
              Compare selected ({selected.length}/2)
            </button>
          )}
          <Link to="/" className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-white rounded-control px-4 py-2.75 text-[13.5px] font-bold transition-colors">+ New test</Link>
        </div>
      </div>

      <div className="px-4 md:px-9 py-6 flex flex-col gap-4">
        {/* Filter bar */}
        <div className="flex items-center gap-2.5 flex-wrap">
          <div className="flex items-center gap-2 bg-surface border border-border rounded-control px-3.5 py-2.5 flex-1 min-w-[220px]">
            <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="var(--tx-5)" strokeWidth="1.8"><circle cx="9" cy="9" r="5.5" /><path d="M13.5 13.5 17 17" strokeLinecap="round" /></svg>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by URL or tag…"
              className="flex-1 bg-transparent border-none text-[13px] focus:outline-none placeholder:text-tx-5"
            />
          </div>
          <div className="flex bg-surface border border-border rounded-control p-1 gap-0.5">
            {([
              { id: 'all', label: 'All' }, { id: 'backend', label: 'Backend' },
              { id: 'client-side', label: 'Browser' }, { id: 'flow', label: 'Flow' },
            ] as const).map(t => (
              <button key={t.id} onClick={() => setTypeFilter(t.id)}
                className={`px-3.5 py-1.75 rounded-[8px] text-[12.5px] cursor-pointer ${typeFilter === t.id ? 'bg-sel text-white font-semibold' : 'text-tx-3'}`}>
                {t.label}
              </button>
            ))}
          </div>
          <select value={dateRange} onChange={e => setDateRange(e.target.value as typeof dateRange)}
            className="bg-surface border border-border rounded-control px-3.5 py-2.5 text-[13px] text-tx-3 focus:outline-none">
            {DATE_RANGES.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
        </div>

        {loading ? (
          <div className="bg-surface border border-border rounded-card p-8 text-center text-[13px] text-tx-4">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="bg-surface border border-border rounded-card p-8 text-center">
            <p className="text-tx-4 text-[13px]">{results.length === 0 ? 'No results yet' : 'No results match your filters'}</p>
            {results.length === 0 && <Link to="/" className="text-accent text-[12.5px] hover:underline mt-2 block">Run your first test →</Link>}
          </div>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden md:block bg-surface border border-border rounded-card overflow-hidden overflow-x-auto">
              <div className="grid grid-cols-[22px_2.2fr_90px_1fr_1fr_1fr_90px_60px] gap-3.5 min-w-[700px] px-5.5 py-3 bg-surface-2 border-b border-border font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase">
                <span />
                <span>Target</span><span>Type</span><span>p95</span><span>Errors</span><span>When</span><span className="text-right">Status</span><span />
              </div>
              {filtered.map(r => {
                return (
                  <div
                    key={r.id}
                    onClick={() => navigate(`/results/${r.test_id}`)}
                    className={`grid grid-cols-[22px_2.2fr_90px_1fr_1fr_1fr_90px_60px] gap-3.5 min-w-[700px] px-5.5 py-3.5 items-center border-b border-border-3 last:border-b-0 cursor-pointer hover:bg-hover ${selected.includes(r.test_id) ? 'bg-orange-bg/40' : ''}`}
                  >
                    <span onClick={e => e.stopPropagation()}>
                      {r.status === 'completed' ? (
                        <input type="checkbox" checked={selected.includes(r.test_id)} onChange={() => toggleSelect(r.test_id)} className="cursor-pointer" />
                      ) : <StatusDot status={r.status} perf={r.perf_status} />}
                    </span>
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5">
                        {r.is_baseline && <span className="text-[9px] font-bold text-amber-badge-fg bg-amber-bg rounded-chip px-1">B</span>}
                        <span className="font-mono text-[13px] text-tx truncate">{r.target_url}</span>
                      </span>
                    </span>
                    <span><TypeTag type={r.type} /></span>
                    <span className="font-display text-[14.5px] font-semibold">{p95Value(r)}</span>
                    <span className="font-display text-[13.5px] text-tx-3">{errValue(r)}</span>
                    <span className="text-[12.5px] text-tx-4">{relTime(r.created_at)}</span>
                    <span className={`justify-self-end text-[10.5px] font-bold rounded-chip px-2.25 py-0.75 ${STATUS_BADGE_CLS[statusBadge(r)] ?? 'text-tx-3 bg-surface-2'}`}>{statusBadge(r)}</span>
                    <span className="justify-self-end flex items-center gap-2" onClick={e => e.stopPropagation()}>
                      {r.status === 'completed' && (
                        <button onClick={() => navigate(`/?rerun=${r.test_id}`)} title="Re-run" aria-label="Re-run" className="text-tx-4 hover:text-tx text-[13px]">↻</button>
                      )}
                      <Link to={`/results/${r.test_id}`} className="text-accent text-[12px] hover:underline">View →</Link>
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Load more */}
            {nextBefore && (
              <div className="flex justify-center pt-2">
                <button onClick={loadMore} disabled={loadingMore} className="px-4 py-2 border border-border bg-surface hover:bg-hover text-tx rounded-control text-[13px] disabled:opacity-50 transition-colors">
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}

            {/* Mobile card list */}
            <div className="md:hidden space-y-2.5">
              {filtered.map(r => (
                <div key={r.id} className="block bg-surface border border-border rounded-control px-3.5 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <Link to={`/results/${r.test_id}`} className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <StatusDot status={r.status} perf={r.perf_status} />
                        <span className="font-mono text-[13px] text-tx font-medium truncate">{r.target_url.replace(/https?:\/\//, '')}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-1.5">
                        <TypeTag type={r.type} />
                        <span className="text-[11px] font-mono text-tx-4">{relTime(r.created_at)}</span>
                        <span className={`text-[10px] font-bold rounded-chip px-1.5 py-0.5 ${STATUS_BADGE_CLS[statusBadge(r)] ?? 'text-tx-3 bg-surface-2'}`}>{statusBadge(r)}</span>
                      </div>
                      <div className="text-[11px] font-mono text-tx-4 mt-1">{p95Value(r)} · {errValue(r)}</div>
                    </Link>
                    <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                      <span className="text-[13px] text-accent">→</span>
                      {r.status === 'completed' && (
                        <button onClick={() => navigate(`/?rerun=${r.test_id}`)} className="text-[11px] text-tx-4 hover:text-tx">↻ Re-run</button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
