import { useEffect, useRef, useState } from 'react';
import { getResults, TestResult } from '@/lib/api';
import { useResultsSocket } from '@/lib/useResultsSocket';
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
    perf === 'passed'  ? 'bg-[#1f883d]' :
    perf === 'failed'  ? 'bg-[#cf222e]' :
    perf === 'degraded'? 'bg-[#9a6700]' :
    status === 'running' || status === 'pending' ? 'bg-[#0969da] animate-pulse' :
    status === 'failed' || status === 'cancelled' ? 'bg-[#cf222e]' :
    'bg-[#8c959f]';
  return <span className={`w-2 h-2 rounded-full inline-block flex-shrink-0 ${cls}`} />;
};

const TypeTag = ({ type }: { type: string }) => {
  const cls =
    type === 'backend'   ? 'text-[#0969da] border-[#c8e1ff] bg-[#f1f8ff]' :
    type === 'flow'      ? 'text-[#4338ca] border-[#c7d2fe] bg-[#eef2ff]' :
                          'text-[#7c3aed] border-[#e9d5ff] bg-[#faf5ff]';
  return (
    <span className={`inline-block px-1.5 py-0 border rounded text-[10px] font-mono ${cls}`}>
      {type}
    </span>
  );
};

const PerfTag = ({ status }: { status: string }) => {
  const cls =
    status === 'passed'  ? 'bg-[#dafbe1] text-[#1a7f37]' :
    status === 'failed'  ? 'bg-[#ffebe9] text-[#cf222e]' :
                          'bg-[#fff8c5] text-[#9a6700]';
  return (
    <span className={`inline-block px-1.5 rounded text-[10px] font-mono ${cls}`}>{status}</span>
  );
};

function getMainMetric(r: TestResult) {
  if (!r.metrics) return null;
  if (r.type === 'client-side') return `LCP: ${Math.round(r.metrics.lcp ?? 0)}ms · TTFB: ${Math.round(r.metrics.ttfb ?? 0)}ms`;
  return `p95: ${Math.round(r.metrics.p95ResponseTime ?? 0)}ms · ${(r.metrics.rps ?? 0).toFixed(1)} rps`;
}

export default function ResultsPage() {
  const [results, setResults] = useState<TestResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const navigate = useNavigate();
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = async () => {
    const data = await getResults();
    setResults(data.results || []);
    setLoading(false);
  };

  // Initial load
  useEffect(() => { refresh(); }, []);

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

  return (
    <div className="p-4 lg:p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-[15px] font-semibold text-[#24292f]">Results</h1>
        <div className="flex items-center gap-2">
          {selected.length === 1 && (
            <span className="text-[12px] text-[#57606a]">Select one more to compare</span>
          )}
          {selected.length === 2 && (
            <button
              onClick={() => navigate(`/results/compare?a=${selected[0]}&b=${selected[1]}`)}
              className="px-3 py-1.5 border border-[#d0d7de] bg-white hover:bg-[#eaeef2] text-[#24292f] rounded-md text-[12px] font-medium transition-colors"
            >
              Compare selected ({selected.length}/2)
            </button>
          )}
          <Link
            to="/"
            className="px-3 py-1.5 bg-[#1f883d] hover:bg-[#1a7f37] text-white rounded-md text-[12px] font-medium transition-colors"
          >
            + New Test
          </Link>
        </div>
      </div>

      {loading ? (
        <div className="bg-white border border-[#d0d7de] rounded-md p-8 text-center text-[13px] text-[#57606a]">Loading…</div>
      ) : results.length === 0 ? (
        <div className="bg-white border border-[#d0d7de] rounded-md p-8 text-center">
          <p className="text-[#57606a] text-[13px]">No results yet</p>
          <Link to="/" className="text-[#0969da] text-[12px] hover:underline mt-2 block">Run your first test →</Link>
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block bg-white border border-[#d0d7de] rounded-md overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="bg-[#f6f8fa] border-b border-[#d0d7de]">
                  <th className="w-9 px-3 py-2" />
                  <th className="text-left px-3 py-2 text-[11px] font-semibold text-[#57606a] uppercase tracking-wide">URL / Meta</th>
                  <th className="text-left px-3 py-2 text-[11px] font-semibold text-[#57606a] uppercase tracking-wide">Type</th>
                  <th className="text-left px-3 py-2 text-[11px] font-semibold text-[#57606a] uppercase tracking-wide">Status</th>
                  <th className="text-left px-3 py-2 text-[11px] font-semibold text-[#57606a] uppercase tracking-wide">Analysis</th>
                  <th className="px-3 py-2 text-right text-[11px] font-semibold text-[#57606a] uppercase tracking-wide">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#eaeef2]">
                {results.map(r => {
                  const metric = getMainMetric(r);
                  return (
                    <tr
                      key={r.id}
                      onClick={() => navigate(`/results/${r.test_id}`)}
                      className={`cursor-pointer hover:bg-[#f6f8fa] ${selected.includes(r.test_id) ? 'bg-[#ddf4ff] hover:bg-[#ddf4ff]' : ''}`}
                    >
                      <td className="px-3 py-2.5" onClick={e => e.stopPropagation()}>
                        {r.status === 'completed' && (
                          <input
                            type="checkbox"
                            checked={selected.includes(r.test_id)}
                            onChange={() => toggleSelect(r.test_id)}
                            className="rounded-sm border-[#d0d7de] text-[#0969da] focus:ring-[#0969da] cursor-pointer"
                          />
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1.5">
                          {r.is_baseline && <span className="text-[9px] font-semibold text-[#9a6700] bg-[#fff8c5] border border-[#e3b341] rounded px-1">B</span>}
                          <span className="text-[13px] font-mono text-[#24292f] font-medium max-w-xs truncate">{r.target_url}</span>
                        </div>
                        <div className="text-[11px] font-mono text-[#57606a] mt-0.5">
                          {relTime(r.created_at)}
                          {metric && <span className="ml-2">{metric}</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2.5"><TypeTag type={r.type} /></td>
                      <td className="px-3 py-2.5">
                        <span className="flex items-center gap-1.5 text-[12px] font-mono text-[#57606a]">
                          <StatusDot status={r.status} perf={r.perf_status} />
                          {r.status}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        {r.perf_status && <PerfTag status={r.perf_status} />}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-3">
                          {r.status === 'completed' && (
                            <button
                              onClick={e => { e.stopPropagation(); navigate(`/?rerun=${r.test_id}`); }}
                              className="text-[12px] text-[#57606a] hover:text-[#24292f] hover:underline"
                            >
                              ↻ Re-run
                            </button>
                          )}
                          <Link to={`/results/${r.test_id}`} className="text-[12px] text-[#0969da] hover:underline" onClick={e => e.stopPropagation()}>View →</Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile card list */}
          <div className="md:hidden space-y-2">
            {results.map(r => {
              const metric = getMainMetric(r);
              return (
                <div
                  key={r.id}
                  className="block bg-white border border-[#d0d7de] rounded-md px-3 py-2.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <Link to={`/results/${r.test_id}`} className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <StatusDot status={r.status} perf={r.perf_status} />
                        <span className="font-mono text-[13px] text-[#24292f] font-medium truncate">{r.target_url.replace(/https?:\/\//, '')}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <TypeTag type={r.type} />
                        <span className="text-[11px] font-mono text-[#57606a]">{relTime(r.created_at)}</span>
                        {r.perf_status && <PerfTag status={r.perf_status} />}
                      </div>
                      {metric && <div className="text-[11px] font-mono text-[#57606a] mt-0.5">{metric}</div>}
                    </Link>
                    <div className="flex flex-col items-end gap-1 flex-shrink-0">
                      <span className="text-[13px] text-[#0969da]">→</span>
                      {r.status === 'completed' && (
                        <button
                          onClick={() => navigate(`/?rerun=${r.test_id}`)}
                          className="text-[11px] text-[#57606a] hover:text-[#24292f]"
                        >
                          ↻ Re-run
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
