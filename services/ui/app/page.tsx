import { useState, useEffect, Suspense } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { createTest, getResult, getPresets, createPreset, getResults, getActiveTests, getLiveMetrics, suggestThresholds, suggestSettings, translatePlaywright, suggestPresetName, previewThresholds, ThresholdPreview, Preset, FlowStep, TestResult, ActiveTest, LiveMetricPoint } from '@/lib/api';
import FlowBuilder from '@/app/components/FlowBuilder';
import { useAuth } from '@/lib/AuthContext';
import { useResultsSocket } from '@/lib/useResultsSocket';
import { findScriptTemplate } from '@/lib/scriptTemplates';

interface EnvVar { key: string; value: string }

interface Thresholds {
  p95: string; avg: string; errorRate: string; serverErrorRate: string; timeoutRate: string;
  lcp: string; fcp: string; ttfb: string; cls: string; inp: string; tbt: string;
}

const DEFAULT_THRESHOLDS: Thresholds = {
  p95: '1000', avg: '500', errorRate: '1', serverErrorRate: '1', timeoutRate: '1',
  lcp: '2500', fcp: '1800', ttfb: '800', cls: '0.1', inp: '200', tbt: '200',
};

function relTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fmtElapsed(secs: number) {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Sparkline path generator over a fixed 560x80 viewBox, matching the design's live card chart. */
function sparklinePath(values: number[]): { area: string; line: string } {
  if (values.length < 2) return { area: '', line: '' };
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const stepX = 544 / (values.length - 1);
  const pts = values.map((v, i) => {
    const x = 8 + i * stepX;
    const y = 8 + (1 - (v - min) / range) * 64;
    return [x, y];
  });
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lastX] = pts[pts.length - 1];
  const [firstX] = pts[0];
  const area = `${line} L${lastX},80 L${firstX},80 Z`;
  return { area, line };
}

function LiveCard({ test }: { test: ActiveTest }) {
  const navigate = useNavigate();
  const [points, setPoints] = useState<LiveMetricPoint[]>([]);
  const [meta, setMeta] = useState<{ startedAt: string | null; durationSeconds: number | null } | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    getLiveMetrics(test.test_id).then(d => setPoints(d.points ?? [])).catch(() => {});
    getResult(test.test_id).then(({ result }) => setMeta({ startedAt: result.started_at, durationSeconds: result.duration_seconds })).catch(() => {});
  }, [test.test_id]);

  useResultsSocket(event => {
    if (event.type === 'test:live' && event.testId === test.test_id) {
      setPoints(p => [...p, event.point].slice(-40));
    }
  });

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const latest = points[points.length - 1];
  const elapsed = meta?.startedAt ? Math.max(0, Math.floor((now - new Date(meta.startedAt).getTime()) / 1000)) : 0;
  const { area, line } = sparklinePath(points.map(p => p.avgResponseTime));

  return (
    <div
      onClick={() => navigate(`/results/${test.test_id}`)}
      className="rounded-card p-5.5 cursor-pointer text-white"
      style={{ background: 'var(--livecard)', border: '1px solid var(--livecard-bd)' }}
    >
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-live pulse-ring inline-block" />
          <span className="font-mono text-[11px] tracking-[0.12em] text-live">RUNNING</span>
        </span>
        <span className="font-mono text-[12px] text-tx-4">
          {fmtElapsed(elapsed)}{meta?.durationSeconds ? ` / ${fmtElapsed(meta.durationSeconds)}` : ''}
        </span>
      </div>
      <div className="font-mono text-[13.5px] text-sidebar-bright mt-2.5 truncate">{test.target_url}</div>
      <div className="flex items-end gap-7 mt-3.5">
        <div>
          <div className="font-mono text-[10.5px] text-tx-4 uppercase tracking-[0.06em]">avg</div>
          <div className="font-display text-[30px] font-bold text-white leading-none mt-1">{latest ? Math.round(latest.avgResponseTime) : '—'}<span className="text-[15px] text-tx-4">ms</span></div>
        </div>
        <div>
          <div className="font-mono text-[10.5px] text-tx-4 uppercase tracking-[0.06em]">VUs</div>
          <div className="font-display text-[30px] font-bold text-white leading-none mt-1">{latest ? Math.round(latest.vus) : '—'}</div>
        </div>
        <div>
          <div className="font-mono text-[10.5px] text-tx-4 uppercase tracking-[0.06em]">err</div>
          <div className="font-display text-[30px] font-bold text-white leading-none mt-1">{latest ? latest.errorRate.toFixed(1) : '0.0'}<span className="text-[15px] text-tx-4">%</span></div>
        </div>
      </div>
      {points.length > 1 ? (
        <svg viewBox="0 0 560 80" preserveAspectRatio="none" className="w-full h-15 block mt-3.5">
          <defs><linearGradient id="liveCardGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#34d27b" stopOpacity=".3" /><stop offset="1" stopColor="#34d27b" stopOpacity="0" /></linearGradient></defs>
          <path d={area} fill="url(#liveCardGrad)" />
          <path d={line} fill="none" stroke="#34d27b" strokeWidth="2.2" />
        </svg>
      ) : <div className="h-15 mt-3.5" />}
    </div>
  );
}

function RecentRuns({ recent }: { recent: TestResult[] }) {
  const navigate = useNavigate();
  const completed = recent.filter(r => r.status === 'completed').slice(0, 4);
  return (
    <div className="bg-surface border border-border rounded-card px-6 py-4.5 flex-1">
      <div className="flex items-center justify-between mb-1.5">
        <span className="font-display text-[15px] font-semibold">Recent runs</span>
        <Link to="/results" className="text-[12.5px] text-accent font-semibold">View all →</Link>
      </div>
      {completed.length === 0 && <p className="text-[12.5px] text-tx-4 py-3">No completed runs yet.</p>}
      {completed.map((r, i) => {
        const metricVal = typeof r.metrics?.p95ResponseTime === 'number' ? `${Math.round(r.metrics.p95ResponseTime)}ms`
          : typeof r.metrics?.lcp === 'number' ? `${Math.round(r.metrics.lcp)}ms` : '—';
        const arrow = r.perf_status === 'passed' ? { sym: '↑', cls: 'text-green-fg' } : r.perf_status === 'failed' ? { sym: '↓', cls: 'text-red-fg' } : { sym: '→', cls: 'text-amber-fg' };
        return (
          <div
            key={r.id}
            onClick={() => navigate(`/results/${r.test_id}`)}
            className={`flex items-center gap-3 py-2.75 cursor-pointer ${i < completed.length - 1 ? 'border-b border-line' : ''}`}
          >
            <span className={`font-display text-[13px] font-bold w-3.5 ${arrow.cls}`}>{arrow.sym}</span>
            <span className="font-mono text-[12.5px] text-tx-2 flex-1 min-w-0 truncate">{r.target_url.replace(/https?:\/\//, '')}</span>
            <span className="font-display text-[14px] font-semibold">{metricVal}</span>
          </div>
        );
      })}
    </div>
  );
}

const DURATION_OPTIONS = ['30s', '1m', '2m', '3m', '5m', '10m', '30m'];
const toSecs = (d: string) => {
  const m = d.match(/^(\d+)(s|m|h)$/);
  if (!m) return 0;
  return parseInt(m[1]) * (m[2] === 'h' ? 3600 : m[2] === 'm' ? 60 : 1);
};
const snapDuration = (secs: number) =>
  DURATION_OPTIONS.reduce((best, opt) =>
    Math.abs(toSecs(opt) - secs) < Math.abs(toSecs(best) - secs) ? opt : best
  );

function HomeContent() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const isViewer = user?.role === 'viewer';
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [presets, setPresets] = useState<Preset[]>([]);
  const [savingPreset, setSavingPreset] = useState(false);
  const [showThresholds, setShowThresholds] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [thresholds, setThresholds] = useState<Thresholds>(DEFAULT_THRESHOLDS);
  const [suggestingThresholds, setSuggestingThresholds] = useState(false);
  const [thresholdSuggestionNote, setThresholdSuggestionNote] = useState<string | null>(null);
  const [previewingThresholds, setPreviewingThresholds] = useState(false);
  const [thresholdPreview, setThresholdPreview] = useState<ThresholdPreview | null>(null);
  const [thresholdPreviewError, setThresholdPreviewError] = useState<string | null>(null);
  const [recent, setRecent] = useState<TestResult[]>([]);
  const [active, setActive] = useState<ActiveTest[]>([]);
  const [rerunFrom, setRerunFrom] = useState<string | null>(null);
  const [form, setForm] = useState({
    type: 'backend' as 'backend' | 'client-side' | 'flow',
    targetUrl: '',
    description: '',
    vus: 5,
    peakVus: 50,
    sessions: 2,
    duration: '30s',
    rampUp: '',
    collectWebVitals: true,
    profile: 'load' as 'load' | 'spike' | 'capacity' | 'soak',
    httpKeepAlive: true,
    httpTimeout: '',
    httpDiscardBodies: false,
  });
  const [flowSteps, setFlowSteps] = useState<FlowStep[]>([]);
  const [flowTestData, setFlowTestData] = useState<Array<Record<string, string>>>([]);
  const [flowCsvFile, setFlowCsvFile] = useState<{ name: string; data: string } | null>(null);
  const [flowEnvVars, setFlowEnvVars] = useState<EnvVar[]>([]);
  const [flowRunner, setFlowRunner] = useState<'k6' | 'browser'>('k6');
  const [scriptMode, setScriptMode] = useState<'ai' | 'custom'>('ai');
  const [customScript, setCustomScript] = useState('');
  const [translating, setTranslating] = useState(false);
  const [suggestingSettings, setSuggestingSettings] = useState(false);
  const [settingsSuggestionNote, setSettingsSuggestionNote] = useState<string | null>(null);
  const [presetNameSuggestion, setPresetNameSuggestion] = useState<{ name: string; tags: string[] } | null>(null);
  const [customHeaders, setCustomHeaders] = useState<EnvVar[]>([]);

  const applyDescriptionParams = (desc: string) => {
    const updates: Partial<typeof form> = {};

    // ── Test type detection ──────────────────────────────────────────────────
    const isBrowser = /\b(browser|puppeteer|real\s+browser|web\s+vitals?|lighthouse|client[\s-]?side|page)\b/i.test(desc);
    const isBackend  = /\b(backend|api\s+test|load\s+test|http\s+test|k6|performance\s+test|endpoint)\b/i.test(desc);
    if (isBrowser && !isBackend) {
      updates.type = 'client-side';
      // For flow tab: also flip the runner to browser
      setFlowRunner('browser');
    } else if (isBackend && !isBrowser) {
      updates.type = 'backend';
      setFlowRunner('k6');
    }

    // ── Numeric params ───────────────────────────────────────────────────────
    const vusM = desc.match(/\b(\d+)\s*(?:virtual\s+users?|vus?|users?|concurrent)\b/i);
    if (vusM) updates.vus = Math.min(100, Math.max(1, parseInt(vusM[1])));
    const sessM = desc.match(/\b(\d+)\s*(?:sessions?|browsers?|tabs?)\b/i);
    if (sessM) updates.sessions = Math.min(10, Math.max(1, parseInt(sessM[1])));
    const durM = desc.match(/\b(?:full\s+)?duration[:\s]+(\d+)\s*(minutes?|mins?|seconds?|secs?|hours?|hrs?|[smh])\b|\b(\d+)\s*(?:minute|min|second|sec|hour|hr)s?\s+(?:duration|test|long)\b|\bfor\s+(\d+)\s*(minutes?|mins?|seconds?|secs?|hours?|hrs?|[smh])\b|\b(\d+)\s*(minutes?|mins?|hours?|hrs?|seconds?|secs?)\b/i);
    if (durM) {
      const n = parseInt(durM[1] ?? durM[3] ?? durM[4] ?? durM[6]);
      const u = (durM[2] ?? durM[5] ?? durM[7] ?? 'm').toLowerCase()[0];
      const secs = n * (u === 'h' ? 3600 : u === 'm' ? 60 : 1);
      updates.duration = snapDuration(secs);
    }
    const rampM = desc.match(/\bramp(?:\s*[-\s]?up)?[:\s]+(\d+)\s*(minutes?|mins?|seconds?|secs?|[sm])\b/i);
    if (rampM) {
      const n = parseInt(rampM[1]);
      const u = rampM[2].toLowerCase()[0];
      updates.rampUp = u === 'm' ? `${n}m` : `${n}s`;
    }

    // ── Load profile ─────────────────────────────────────────────────────────
    if (/\bspike\b/i.test(desc)) updates.profile = 'spike';
    else if (/\bsoak\b/i.test(desc)) updates.profile = 'soak';
    else if (/\bcapacity\b/i.test(desc)) updates.profile = 'capacity';
    else if (/\bload\b/i.test(desc)) updates.profile = 'load';

    if (Object.keys(updates).length > 0) {
      setForm(f => ({ ...f, ...updates }));
      // Open advanced settings if anything meaningful was detected
      if (Object.keys(updates).some(k => k !== 'type')) setShowAdvanced(true);
    }
  };

  const refreshOverview = () => {
    getResults().then(d => setRecent(d.results?.slice(0, 10) ?? [])).catch(() => {});
    getActiveTests().then(d => setActive(d.active ?? [])).catch(() => {});
  };

  useResultsSocket((event) => {
    if (event.type === 'tests:changed' || event.type === 'test:status' || event.type === 'reconnected') refreshOverview();
  });

  useEffect(() => {
    getPresets().then(d => setPresets(d.presets ?? [])).catch(() => {});
    refreshOverview();

    const rerun = searchParams.get('rerun');
    if (rerun) {
      getResult(rerun).then(({ result }) => {
        if (!result) return;
        const type = result.type as 'backend' | 'client-side' | 'flow';
        setForm(f => ({
          ...f,
          type,
          targetUrl: result.target_url,
          ...(result.script_description ? { description: result.script_description } : {}),
          ...(result.duration_seconds   ? { duration: snapDuration(result.duration_seconds) } : {}),
        }));
        // Restore flow steps so the FlowBuilder is not empty on re-run
        if (type === 'flow' && result.steps && result.steps.length > 0) {
          setFlowSteps(result.steps);
        }
        // Restore parameterization rows
        if (result.test_data && result.test_data.length > 0) {
          setFlowTestData(result.test_data);
        }
        setRerunFrom(result.target_url);
        setShowAdvanced(true);
      }).catch(() => {});
      return;
    }

    const useScriptTemplate = searchParams.get('useScriptTemplate');
    if (useScriptTemplate) {
      const template = findScriptTemplate(useScriptTemplate);
      if (template) {
        setForm(f => ({ ...f, type: 'backend' }));
        setScriptMode('custom');
        setCustomScript(template.script);
        setShowAdvanced(true);
      }
      return;
    }

    const type = searchParams.get('type') as 'backend' | 'client-side' | 'flow' | null;
    const targetUrl = searchParams.get('targetUrl');
    const description = searchParams.get('description');
    const vus = searchParams.get('vus');
    const sessions = searchParams.get('sessions');
    const duration = searchParams.get('duration');
    const profile = searchParams.get('profile') as 'load' | 'spike' | 'capacity' | 'soak' | null;
    if (type || targetUrl) {
      setForm(f => ({
        ...f,
        ...(type        ? { type }                      : {}),
        ...(targetUrl   ? { targetUrl }                 : {}),
        ...(description ? { description }               : {}),
        ...(vus         ? { vus: Number(vus) }          : {}),
        ...(sessions    ? { sessions: Number(sessions) } : {}),
        ...(duration    ? { duration }                  : {}),
        ...(profile     ? { profile }                   : {}),
      }));
    }
  }, [searchParams]);

  const handleLoadPreset = (id: string) => {
    if (!id) return;
    const t = presets.find(t => t.id === id);
    if (!t) return;
    const opts = t.options as Record<string, unknown>;
    setForm(f => ({
      ...f,
      type: t.type as 'backend' | 'client-side' | 'flow',
      ...(t.target_url                 ? { targetUrl: t.target_url }              : {}),
      ...((t.description ?? t.name)    ? { description: t.description ?? t.name } : {}),
      ...(opts.vus                     ? { vus: Number(opts.vus) }                : {}),
      ...(opts.peakVus                 ? { peakVus: Number(opts.peakVus) }        : {}),
      ...(opts.sessions                ? { sessions: Number(opts.sessions) }      : {}),
      ...(opts.duration                ? { duration: String(opts.duration) }      : {}),
      ...(opts.profile                 ? { profile: opts.profile as typeof f.profile } : {}),
      ...(opts.rampUp                  ? { rampUp: String(opts.rampUp) }              : {}),
    }));
    if (t.thresholds) {
      const th = t.thresholds as Record<string, unknown>;
      setThresholds(prev => ({
        ...prev,
        ...(th.p95       != null ? { p95:       String(th.p95)       } : {}),
        ...(th.avg       != null ? { avg:       String(th.avg)       } : {}),
        ...(th.errorRate != null ? { errorRate: String(th.errorRate) } : {}),
        ...(th.lcp       != null ? { lcp:       String(th.lcp)       } : {}),
        ...(th.fcp       != null ? { fcp:       String(th.fcp)       } : {}),
        ...(th.ttfb      != null ? { ttfb:      String(th.ttfb)      } : {}),
        ...(th.cls       != null ? { cls:       String(th.cls)       } : {}),
        ...(th.inp       != null ? { inp:       String(th.inp)       } : {}),
        ...(th.tbt       != null ? { tbt:       String(th.tbt)       } : {}),
      }));
      setShowThresholds(true);
    }
  };

  const handleSavePreset = async () => {
    if (!form.description && !form.targetUrl) { setError('Add a description or URL before saving as preset'); return; }
    setSavingPreset(true);
    setPresetNameSuggestion(null);
    try {
      // AI-14: get a name suggestion before saving — bounded by a short timeout so a
      // slow/unreachable Gemini call can't block the save (falls back to description/URL)
      let presetName = form.description || form.targetUrl || 'Unnamed test';
      try {
        const suggestion = await Promise.race([
          suggestPresetName({
            url: form.targetUrl, type: form.type,
            vus: form.vus, duration: form.duration, profile: form.profile,
            stepCount: form.type === 'flow' ? flowSteps.length : undefined,
          }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
        ]);
        setPresetNameSuggestion(suggestion);
        presetName = suggestion.name;
      } catch { /* non-fatal, use fallback name */ }

      const options = form.type === 'client-side'
        ? { sessions: form.sessions, duration: form.duration, collectWebVitals: form.collectWebVitals }
        : { vus: form.vus, duration: form.duration, profile: form.profile, peakVus: form.peakVus, ...(form.rampUp ? { rampUp: form.rampUp } : {}) };
      const savedThresholds = showThresholds ? buildThresholds() : null;
      await createPreset({
        name: presetName,
        description: form.description || null,
        type: form.type === 'flow' ? 'backend' : form.type,
        target_url: form.targetUrl || null,
        options,
        thresholds: savedThresholds ?? null,
      });
      const data = await getPresets();
      setPresets(data.presets ?? []);
    } finally {
      setSavingPreset(false);
    }
  };

  const buildCustomHeaders = () => {
    const map: Record<string, string> = {};
    for (const h of customHeaders) { if (h.key) map[h.key] = h.value; }
    return Object.keys(map).length > 0 ? map : undefined;
  };

  const buildHttpOptions = () => {
    if (form.type === 'client-side') return undefined;
    const opts: Record<string, unknown> = {};
    if (!form.httpKeepAlive) opts.keepAlive = false;
    if (form.httpTimeout)    opts.timeout = form.httpTimeout;
    if (form.httpDiscardBodies) opts.discardResponseBodies = true;
    return Object.keys(opts).length > 0 ? opts : undefined;
  };

  const buildThresholds = () => {
    if (!showThresholds) return undefined;
    if (form.type === 'client-side') {
      return {
        ...(thresholds.lcp  ? { lcp:  Number(thresholds.lcp)  } : {}),
        ...(thresholds.fcp  ? { fcp:  Number(thresholds.fcp)  } : {}),
        ...(thresholds.ttfb ? { ttfb: Number(thresholds.ttfb) } : {}),
        ...(thresholds.cls  ? { cls:  Number(thresholds.cls)  } : {}),
        ...(thresholds.inp  ? { inp:  Number(thresholds.inp)  } : {}),
        ...(thresholds.tbt  ? { tbt:  Number(thresholds.tbt)  } : {}),
      };
    }
    return {
      ...(thresholds.p95             ? { p95:             Number(thresholds.p95)             } : {}),
      ...(thresholds.avg             ? { avg:             Number(thresholds.avg)             } : {}),
      ...(thresholds.errorRate       ? { errorRate:       Number(thresholds.errorRate)       } : {}),
      ...(thresholds.serverErrorRate ? { serverErrorRate: Number(thresholds.serverErrorRate) } : {}),
      ...(thresholds.timeoutRate     ? { timeoutRate:     Number(thresholds.timeoutRate)     } : {}),
    };
  };

  const handleSuggestSettings = async () => {
    if (!form.targetUrl) return;
    setSuggestingSettings(true);
    setSettingsSuggestionNote(null);
    try {
      const s = await suggestSettings(form.targetUrl, form.type);
      setForm(f => ({
        ...f,
        ...(s.vus      ? { vus:     s.vus }     : {}),
        ...(s.duration ? { duration: s.duration } : {}),
        ...(s.profile  ? { profile:  s.profile as 'load'|'spike'|'soak'|'capacity' } : {}),
      }));
      setShowAdvanced(true);
      setSettingsSuggestionNote(s.reasoning);
    } catch (e) { setSettingsSuggestionNote((e as Error).message); }
    finally { setSuggestingSettings(false); }
  };

  const handleSuggestThresholds = async () => {
    if (!form.targetUrl) return;
    setSuggestingThresholds(true);
    setThresholdSuggestionNote(null);
    try {
      const { suggestions, runsAnalysed } = await suggestThresholds(form.targetUrl, form.type);
      setThresholds(t => ({
        ...t,
        ...(suggestions.p95        ? { p95:       String(suggestions.p95)       } : {}),
        ...(suggestions.avg        ? { avg:       String(suggestions.avg)       } : {}),
        ...(suggestions.errorRate  ? { errorRate: String(suggestions.errorRate) } : {}),
      }));
      setShowThresholds(true);
      setThresholdSuggestionNote(`Based on ${runsAnalysed} runs — ${suggestions.reasoning}`);
    } catch (err) {
      setThresholdSuggestionNote((err as Error).message);
    } finally {
      setSuggestingThresholds(false);
    }
  };

  const handlePreviewThresholds = async () => {
    if (!form.targetUrl) return;
    setPreviewingThresholds(true);
    setThresholdPreviewError(null);
    setThresholdPreview(null);
    try {
      const previewType = form.type === 'flow' ? (flowRunner === 'browser' ? 'client-side' : 'flow') : form.type;
      const result = await previewThresholds(form.targetUrl, previewType, buildThresholds() ?? {});
      setThresholdPreview(result);
    } catch (err) {
      setThresholdPreviewError((err as Error).message);
    } finally {
      setPreviewingThresholds(false);
    }
  };

  const handleSubmit = async () => {
    if (form.type === 'flow') {
      if (flowSteps.length === 0) { setError('Add at least one step to run a flow test'); return; }
      if (flowSteps.length > 20) { setError(`Flow tests support a maximum of 20 steps — remove ${flowSteps.length - 20} step${flowSteps.length - 20 === 1 ? '' : 's'} before running`); return; }
      if (flowSteps.some(s => !s.url)) { setError('Every step must have a URL'); return; }
    } else if (!form.targetUrl && !(form.type === 'backend' && scriptMode === 'custom')) {
      setError('URL is required');
      return;
    }
    if (form.type === 'backend' && scriptMode === 'custom' && !customScript.trim()) {
      setError('Paste or upload a k6 script');
      return;
    }
    setLoading(true);
    setError('');

    try {
      if (form.type === 'flow') {
        const envVarsMap: Record<string, string> = {};
        for (const ev of flowEnvVars) { if (ev.key) envVarsMap[ev.key] = ev.value; }

        if (flowRunner === 'browser') {
          // Run as Puppeteer browser test — one real browser session navigating the steps
          const stepsDesc = flowSteps.map((s, i) => `Step ${i + 1}: ${s.method} ${s.url}`).join(', ');
          const description = form.description || `Browser flow: ${stepsDesc}`;
          const res = await createTest({
            type: 'client-side',
            targetUrl: flowSteps[0]?.url ?? '',
            description,
            options: { sessions: form.sessions, duration: form.duration, collectWebVitals: form.collectWebVitals },
            steps: flowSteps,
            envVars: Object.keys(envVarsMap).length > 0 ? envVarsMap : undefined,
            thresholds: buildThresholds(),
          });
          if (res.test?.id) navigate(`/results/${res.test.id}`);
          return;
        }

        const res = await createTest({
          type: 'flow',
          targetUrl: flowSteps[0]?.url ?? '',
          description: form.description || `Flow test (${flowSteps.length} steps)`,
          options: { vus: form.vus, duration: form.duration, ...(form.rampUp ? { rampUp: form.rampUp } : {}), ...(buildHttpOptions() ? { httpOptions: buildHttpOptions() } : {}) },
          steps: flowSteps,
          envVars: Object.keys(envVarsMap).length > 0 ? envVarsMap : undefined,
          testData: flowTestData.length > 0 ? flowTestData : undefined,
          csvData: flowCsvFile?.data,
          csvFilename: flowCsvFile?.name,
          thresholds: buildThresholds(),
        });
        if (res.test?.id) navigate(`/results/${res.test.id}`);
        return;
      }

      const httpOpts = buildHttpOptions();
      const customHeadersOpt = buildCustomHeaders();
      const options = form.type === 'backend'
        ? { vus: form.vus, duration: form.duration, profile: form.profile, peakVus: form.peakVus, ...(form.rampUp ? { rampUp: form.rampUp } : {}), ...(httpOpts ? { httpOptions: httpOpts } : {}), ...(customHeadersOpt ? { headers: customHeadersOpt } : {}) }
        : { sessions: form.sessions, duration: form.duration, collectWebVitals: form.collectWebVitals, ...(customHeadersOpt ? { headers: customHeadersOpt } : {}) };

      const isCustomScript = form.type === 'backend' && scriptMode === 'custom' && customScript.trim();
      // In custom script mode the URL is optional — extract from the script or fall back to localhost
      const effectiveUrl = form.targetUrl || (isCustomScript
        ? (customScript.match(/https?:\/\/[^\s'"`,)]+/)?.[0]?.replace(/['"`,);]+$/, '') ?? 'http://localhost')
        : '');
      const res = await createTest({
        type: form.type,
        targetUrl: effectiveUrl,
        description: form.description || `Custom k6 script — ${effectiveUrl}`,
        ...(isCustomScript ? { customScript: customScript.trim() } : {}),
        options,
        thresholds: buildThresholds(),
      });

      if (res.test?.id) navigate(`/results/${res.test.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create test');
    } finally {
      setLoading(false);
    }
  };

  const inputCls = "w-full bg-bg border border-border rounded-control px-3.5 py-2.75 text-[13.5px] font-display font-semibold text-tx focus:outline-none focus:border-ink-bd placeholder:font-sans placeholder:font-normal placeholder:text-tx-5";

  const completedToday = recent.filter(r => r.status === 'completed' && new Date(r.created_at).toDateString() === new Date().toDateString());
  const passCount = completedToday.filter(r => r.perf_status === 'passed').length;
  const passRate = completedToday.length > 0 ? Math.round((passCount / completedToday.length) * 100) : null;
  const backendCompleted = completedToday.filter(r => typeof r.metrics?.p95ResponseTime === 'number');
  const avgP95 = backendCompleted.length > 0 ? Math.round(backendCompleted.reduce((s, r) => s + r.metrics.p95ResponseTime, 0) / backendCompleted.length) : null;
  const rpsResults = completedToday.filter(r => typeof r.metrics?.rps === 'number');
  const avgRps = rpsResults.length > 0 ? rpsResults.reduce((s, r) => s + r.metrics.rps, 0) / rpsResults.length : null;

  return (
    <div>
      <div className="px-4 md:px-9 pt-7.5 flex items-start justify-between flex-wrap gap-3.5">
        <div>
          <div className="font-mono text-[11px] tracking-[0.16em] text-accent uppercase mb-1.5">— Overview</div>
          <h1 className="font-display text-[clamp(26px,6.5vw,38px)] font-bold tracking-[-0.025em] leading-none">New test</h1>
        </div>
        <div className="flex items-center gap-2">
          {presets.length > 0 && (
            <select
              value=""
              onChange={e => handleLoadPreset(e.target.value)}
              className="text-[12.5px] border border-border rounded-control px-3 py-2 bg-surface text-tx-3 focus:outline-none"
            >
              <option value="" disabled>Load from preset…</option>
              {presets.map(t => <option key={t.id} value={t.id}>{t.name} ({t.type})</option>)}
            </select>
          )}
        </div>
      </div>

      <div className="px-4 md:px-9 py-6 flex flex-col gap-5">
        {rerunFrom && (
          <div className="flex items-center justify-between px-4 py-2.5 bg-orange-bg border border-orange-bd rounded-control text-[12.5px]">
            <span className="text-accent">↻ Pre-filled from previous run of <span className="font-mono">{rerunFrom}</span> — script will be reused</span>
            <button onClick={() => setRerunFrom(null)} className="text-tx-4 hover:text-tx ml-3 flex-shrink-0" aria-label="Dismiss re-run notice">✕</button>
          </div>
        )}

        {/* Stat band */}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] bg-surface border border-border rounded-card overflow-hidden [&>*:not(:last-child)]:border-r [&>*:not(:last-child)]:border-border-2">
          {[
            { label: 'Tests today', value: completedToday.length, suffix: null },
            { label: 'Pass rate', value: passRate ?? '—', suffix: passRate !== null ? '%' : null, color: passRate !== null && passRate >= 80 ? 'text-green-fg' : passRate !== null ? 'text-amber-fg' : undefined },
            { label: 'Avg p95', value: avgP95 ?? '—', suffix: avgP95 !== null ? 'ms' : null },
            { label: 'Throughput', value: avgRps !== null ? avgRps.toFixed(1) : '—', suffix: avgRps !== null ? '/s' : null },
          ].map(cell => (
            <div key={cell.label} className="px-6 py-5">
              <div className="font-mono text-[10.5px] tracking-[0.1em] text-tx-4 uppercase">{cell.label}</div>
              <div className="flex items-baseline gap-2 mt-2">
                <span className={`font-display text-[38px] font-bold tracking-[-0.03em] leading-none ${cell.color ?? ''}`}>{cell.value}</span>
                {cell.suffix && <span className="text-[18px] text-tx-4">{cell.suffix}</span>}
              </div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:[grid-template-columns:minmax(360px,1fr)_minmax(360px,1fr)] gap-5">
          {/* Composer */}
          <div className="bg-surface border border-border rounded-card p-6.5 flex flex-col gap-4.5">
            <div className="font-display text-[17px] font-semibold">Configure run</div>
            <div className="flex gap-2">
              {([
                { id: 'backend',     label: 'Backend' },
                { id: 'client-side', label: 'Browser' },
                { id: 'flow',        label: 'Flow' },
              ] as const).map(t => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    if (t.id !== form.type) { setThresholds(DEFAULT_THRESHOLDS); setThresholdSuggestionNote(null); }
                    setForm(f => ({ ...f, type: t.id }));
                    if (t.id !== 'backend') { setScriptMode('ai'); setCustomScript(''); }
                  }}
                  className={`flex-1 text-center py-2.75 rounded-control text-[13.5px] cursor-pointer transition-colors ${
                    form.type === t.id ? 'bg-sel text-white font-semibold' : 'border border-border text-tx-3 font-medium'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {form.type === 'flow' && (
              <>
                <FlowBuilder
                  steps={flowSteps}
                  envVars={flowEnvVars}
                  onChange={setFlowSteps}
                  onEnvVarsChange={setFlowEnvVars}
                  testData={flowTestData}
                  onTestDataChange={setFlowTestData}
                  csvFile={flowCsvFile}
                  onCsvChange={setFlowCsvFile}
                  teamId={user?.currentTeamId ?? undefined}
                />
                <div>
                  <div className="font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase mb-1.5">Run as</div>
                  <div className="flex gap-2">
                    {([
                      { id: 'k6',      label: 'k6 HTTP',          desc: 'Load test with many virtual users' },
                      { id: 'browser', label: 'Browser', desc: 'Real browser, Web Vitals, Lighthouse' },
                    ] as const).map(r => (
                      <button
                        key={r.id}
                        type="button"
                        title={r.desc}
                        onClick={() => setFlowRunner(r.id)}
                        className={`flex-1 text-center py-2.5 rounded-control text-[12.5px] cursor-pointer ${
                          flowRunner === r.id ? 'bg-sel text-white font-semibold' : 'border border-border text-tx-3'
                        }`}
                      >
                        {r.label}
                      </button>
                    ))}
                  </div>
                  {flowRunner === 'browser' && (
                    <p className="mt-1.5 text-[12px] text-tx-4 leading-[1.5]">
                      Launches a real Chromium browser. Collects Web Vitals &amp; Lighthouse scores. Uses <strong>sessions</strong> and <strong>duration</strong> from Advanced settings.
                    </p>
                  )}
                </div>
              </>
            )}

            {form.type !== 'flow' && (
              <div>
                <div className="font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase mb-1.5">
                  Target URL
                  {form.type === 'backend' && scriptMode === 'custom' && <span className="ml-1 text-tx-4 normal-case font-normal">(optional — used as result label)</span>}
                </div>
                <div className="flex items-center bg-bg border-[1.5px] border-ink-bd rounded-control overflow-hidden">
                  <span className="font-mono text-[13px] text-tx-4 px-3.5 border-r-[1.5px] border-border h-11.5 flex items-center flex-shrink-0">https://</span>
                  <input
                    type="text"
                    placeholder={form.type === 'backend' && scriptMode === 'custom' ? 'example.com (auto-detected from script if blank)' : 'api.acme.io/checkout'}
                    value={form.targetUrl.replace(/^https?:\/\//, '')}
                    onChange={e => setForm(f => ({ ...f, targetUrl: e.target.value ? `https://${e.target.value.replace(/^https?:\/\//, '')}` : '' }))}
                    className="flex-1 min-w-0 font-mono text-[13.5px] text-tx font-medium px-3.5 py-0 bg-transparent border-none focus:outline-none placeholder:text-tx-5 placeholder:font-normal"
                  />
                </div>
                {form.targetUrl && (
                  <div className="mt-1.5 flex items-center gap-2">
                    <button type="button" onClick={handleSuggestSettings} disabled={suggestingSettings} className="text-[11px] text-accent hover:underline disabled:opacity-50 font-mono">
                      {suggestingSettings ? '⏳ Analysing…' : '✨ Suggest settings'}
                    </button>
                    {settingsSuggestionNote && <span className="text-[11px] text-tx-4 font-mono truncate">{settingsSuggestionNote}</span>}
                  </div>
                )}
              </div>
            )}

            {form.type === 'backend' && (
              <div>
                <div className="font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase mb-1.5">Script source</div>
                <div className="flex gap-2 w-fit">
                  {([
                    { id: 'ai',     label: 'AI Generate'  },
                    { id: 'custom', label: 'Custom Script' },
                  ] as const).map(s => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setScriptMode(s.id)}
                      className={`px-4 py-2 rounded-control text-[13px] font-medium cursor-pointer ${
                        scriptMode === s.id ? 'bg-sel text-white font-semibold' : 'border border-border text-tx-3'
                      }`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {form.type === 'backend' && scriptMode === 'custom' && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <div className="font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase">k6 Script</div>
                  <div className="flex items-center gap-3">
                    <label className="text-[11px] font-mono text-accent hover:underline cursor-pointer">
                      ↑ Upload .js
                      <input type="file" accept=".js,.ts" className="hidden"
                        onChange={async (e) => {
                          const file = e.target.files?.[0]; if (!file) return;
                          setCustomScript(await file.text()); e.target.value = '';
                        }} />
                    </label>
                    <label className={`text-[11px] font-mono cursor-pointer ${translating ? 'text-tx-4' : 'text-accent hover:underline'}`}
                      title="Upload a Playwright .ts/.js file and translate it to k6 with AI">
                      {translating ? '⏳ Translating…' : '✨ Translate Playwright'}
                      <input type="file" accept=".js,.ts" className="hidden" disabled={translating}
                        onChange={async (e) => {
                          const file = e.target.files?.[0]; if (!file) return;
                          const src = await file.text(); e.target.value = '';
                          setTranslating(true);
                          try {
                            const { k6Script } = await translatePlaywright(src, form.targetUrl || undefined);
                            setCustomScript(k6Script);
                          } catch (err) { setError(`Translation failed: ${(err as Error).message}`); }
                          finally { setTranslating(false); }
                        }} />
                    </label>
                  </div>
                </div>
                <textarea
                  value={customScript}
                  onChange={e => setCustomScript(e.target.value)}
                  placeholder={"import http from 'k6/http';\nimport { sleep } from 'k6';\n\nexport const options = { vus: 10, duration: '30s' };\n\nexport default function() {\n  http.get('https://example.com');\n  sleep(1);\n}"}
                  spellCheck={false}
                  className={`${inputCls} font-mono text-[11px] leading-relaxed h-48 resize-y`}
                />
                <p className="text-[10px] text-tx-4 mt-1">Max 512 KB · The script&apos;s own <code className="font-mono">export const options</code> overrides Advanced settings.</p>
              </div>
            )}

            {!(form.type === 'backend' && scriptMode === 'custom') && (
              <div>
                <div className="font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase mb-1.5">
                  What to test? <span className="text-tx-4 normal-case font-normal">(AI parses VUs, duration, profile)</span>
                </div>
                <input
                  type="text"
                  placeholder="e.g. load test with 10 users for 2 minutes, ramp up 30s..."
                  value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  onBlur={e => {
                    const relatedTarget = e.relatedTarget as HTMLElement | null;
                    if (relatedTarget?.closest('[data-run-btn]')) return;
                    applyDescriptionParams(e.target.value);
                  }}
                  className="w-full bg-surface border border-border rounded-control px-3.5 py-2.5 text-[13px] text-tx focus:outline-none focus:border-ink-bd placeholder:text-tx-5"
                />
              </div>
            )}

            {form.type === 'backend' && (
              <div className="bg-bg border border-dashed border-dashed rounded-control px-3.5 py-3 text-[13px] text-tx-4">
                ✦ Try: &ldquo;ramp to 200 users over 1 min, then hold&rdquo;
              </div>
            )}

            {/* Advanced settings */}
            <div>
              <button type="button" onClick={() => setShowAdvanced(v => !v)} className="flex items-center gap-1.5 text-[12.5px] text-tx-3 hover:text-tx py-0.5">
                <span className={`transition-transform inline-block text-[10px] ${showAdvanced ? 'rotate-90' : ''}`}>▶</span>
                Advanced settings
                {!showAdvanced && (
                  <span className="text-[11px] text-tx-4 ml-1 font-mono">
                    {form.type === 'client-side'
                      ? `${form.sessions} sessions · ${form.duration}`
                      : `${form.vus} VUs · ${form.duration}${form.rampUp ? ` · ramp ${form.rampUp}` : ''}${form.type === 'backend' ? ` · ${form.profile}` : ''}`}
                  </span>
                )}
              </button>
              {showAdvanced && (
                <div className="mt-2.5 space-y-3.5 p-4 bg-bg rounded-control border border-border">
                  {form.type === 'backend' && (
                    <div>
                      <div className="font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase mb-1.5">Profile</div>
                      <div className="grid grid-cols-2 gap-1.5">
                        {([
                          { id: 'load',     label: 'Load',     hint: 'Constant VUs' },
                          { id: 'spike',    label: 'Spike',    hint: 'Traffic burst' },
                          { id: 'capacity', label: 'Capacity', hint: 'Find breakpoint' },
                          { id: 'soak',     label: 'Soak',     hint: 'Long steady-state' },
                        ] as const).map(p => (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => setForm(f => ({ ...f, profile: p.id }))}
                            className={`py-2 px-3 rounded-control border text-left transition-colors ${
                              form.profile === p.id ? 'border-ink-bd bg-surface' : 'border-border bg-surface hover:bg-hover'
                            }`}
                          >
                            <div className="text-[12.5px] font-semibold">{p.label}</div>
                            <div className="text-[10.5px] text-tx-4">{p.hint}</div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-3">
                    {form.type === 'client-side' ? (
                      <div>
                        <div className="font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase mb-1.5">Browser sessions</div>
                        <input type="number" min={1} max={10} value={form.sessions}
                          onChange={e => setForm(f => ({ ...f, sessions: Number(e.target.value) }))} className={inputCls} />
                      </div>
                    ) : (
                      <div>
                        <div className="font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase mb-1.5">
                          {form.profile === 'spike' || form.profile === 'capacity' ? 'Baseline VUs' : 'Users'}
                        </div>
                        <input type="number" min={1} max={100} value={form.vus}
                          onChange={e => setForm(f => ({ ...f, vus: Number(e.target.value) }))} className={inputCls} />
                      </div>
                    )}
                    <div>
                      <div className="font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase mb-1.5">Duration</div>
                      <select value={form.duration} onChange={e => setForm(f => ({ ...f, duration: e.target.value }))} className={inputCls}>
                        {DURATION_OPTIONS.map(d => <option key={d} value={d}>{d}</option>)}
                      </select>
                    </div>
                  </div>
                  {form.type !== 'client-side' && (
                    <div>
                      <div className="font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase mb-1.5">Ramp-up <span className="normal-case font-normal text-tx-4">(optional, e.g. 30s, 1m)</span></div>
                      <input type="text" placeholder="30s" value={form.rampUp} onChange={e => setForm(f => ({ ...f, rampUp: e.target.value }))} className={inputCls} />
                    </div>
                  )}
                  {form.type === 'backend' && (form.profile === 'spike' || form.profile === 'capacity') && (
                    <div>
                      <div className="font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase mb-1.5">
                        {form.profile === 'spike' ? 'Peak VUs (spike target)' : 'Max VUs (capacity ceiling)'}
                      </div>
                      <input type="number" min={form.vus + 1} max={500} value={form.peakVus}
                        onChange={e => setForm(f => ({ ...f, peakVus: Number(e.target.value) }))} className={inputCls} />
                    </div>
                  )}

                  {form.type !== 'client-side' && (
                    <div className="pt-3 border-t border-line">
                      <div className="font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase mb-2">HTTP Settings</div>
                      <div className="space-y-2">
                        <label className="flex items-center gap-2 text-[12.5px] text-tx cursor-pointer">
                          <input type="checkbox" checked={form.httpKeepAlive} onChange={e => setForm(f => ({ ...f, httpKeepAlive: e.target.checked }))} className="rounded-sm border-border" />
                          Keep-alive connections
                        </label>
                        <label className="flex items-center gap-2 text-[12.5px] text-tx cursor-pointer">
                          <input type="checkbox" checked={form.httpDiscardBodies} onChange={e => setForm(f => ({ ...f, httpDiscardBodies: e.target.checked }))} className="rounded-sm border-border" />
                          Discard response bodies <span className="text-tx-4">(faster, saves memory)</span>
                        </label>
                        <div>
                          <div className="text-[11px] text-tx-3 mb-1">Request timeout <span className="text-tx-4">(e.g. 30s, 1m)</span></div>
                          <input type="text" placeholder="30s" value={form.httpTimeout} onChange={e => setForm(f => ({ ...f, httpTimeout: e.target.value }))} className={inputCls} />
                        </div>
                      </div>
                    </div>
                  )}

                  {form.type !== 'flow' && (
                    <div className="pt-3 border-t border-line">
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase">Custom Headers</div>
                        <button type="button" onClick={() => setCustomHeaders(h => [...h, { key: '', value: '' }])} className="text-[11px] text-accent hover:underline">+ add</button>
                      </div>
                      {customHeaders.map((h, i) => (
                        <div key={i} className="flex gap-1.5 mb-1.5 items-center">
                          <input type="text" placeholder="Header-Name" value={h.key}
                            onChange={e => setCustomHeaders(hs => hs.map((x, j) => j === i ? { ...x, key: e.target.value } : x))}
                            className="w-40 border border-border rounded-control px-2.5 py-1 text-[11px] font-mono bg-surface focus:outline-none" />
                          <span className="text-tx-4 text-[11px]">:</span>
                          <input type="text" placeholder="value" value={h.value}
                            onChange={e => setCustomHeaders(hs => hs.map((x, j) => j === i ? { ...x, value: e.target.value } : x))}
                            className="flex-1 border border-border rounded-control px-2.5 py-1 text-[11px] font-mono bg-surface focus:outline-none" />
                          <button type="button" onClick={() => setCustomHeaders(hs => hs.filter((_, j) => j !== i))} className="text-tx-4 hover:text-red-fg text-[11px]">✕</button>
                        </div>
                      ))}
                      {customHeaders.length === 0 && <p className="text-[11px] text-tx-4">No custom headers. Sent with every request (e.g. API keys, auth tokens).</p>}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* SLO thresholds */}
            <div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => setShowThresholds(v => !v)} className="flex items-center gap-1.5 text-[12.5px] text-tx-3 hover:text-tx py-0.5">
                  <span className={`transition-transform inline-block text-[10px] ${showThresholds ? 'rotate-90' : ''}`}>▶</span>
                  SLO thresholds
                  {showThresholds && <span className="text-[11px] text-accent ml-1">active</span>}
                </button>
                {form.targetUrl && form.type !== 'flow' && (
                  <button type="button" onClick={handleSuggestThresholds} disabled={suggestingThresholds} className="text-[11px] text-accent hover:underline disabled:opacity-50 font-mono" title="Analyse run history and suggest realistic SLO values">
                    {suggestingThresholds ? '⏳ Analysing…' : '✨ Suggest'}
                  </button>
                )}
              </div>
              {thresholdSuggestionNote && <p className="text-[11px] text-tx-4 mt-1 font-mono">{thresholdSuggestionNote}</p>}
              {showThresholds && (
                <div className="mt-2.5 grid grid-cols-3 gap-2.5 p-4 bg-bg rounded-control border border-border">
                  {(form.type === 'client-side' ? [
                    { key: 'lcp',  label: 'LCP ms'  }, { key: 'fcp',  label: 'FCP ms'  }, { key: 'ttfb', label: 'TTFB ms' },
                    { key: 'cls',  label: 'CLS'     }, { key: 'inp',  label: 'INP ms'  }, { key: 'tbt',  label: 'TBT ms'  },
                  ] : [
                    { key: 'p95', label: 'p95 ms' }, { key: 'avg', label: 'Avg ms' }, { key: 'errorRate', label: 'Err %' },
                    { key: 'serverErrorRate', label: '5xx err %' }, { key: 'timeoutRate', label: 'Timeout %' },
                  ] as const).map(({ key, label }) => (
                    <div key={key}>
                      <div className="text-[10.5px] text-tx-4 mb-1">{label} max</div>
                      <input type="number" min={0} value={(thresholds as unknown as Record<string, string>)[key]}
                        onChange={e => setThresholds(t => ({ ...t, [key]: e.target.value }))} className={inputCls} />
                    </div>
                  ))}
                </div>
              )}
              {showThresholds && form.targetUrl && (
                <div className="mt-2">
                  <button type="button" onClick={handlePreviewThresholds} disabled={previewingThresholds} className="text-[11px] text-accent hover:underline disabled:opacity-50 font-mono" title="Check these thresholds against the most recent completed run for this URL">
                    {previewingThresholds ? '⏳ Checking…' : '👁 Preview against last run'}
                  </button>
                  {thresholdPreviewError && <p className="text-[11px] text-red-fg mt-1 font-mono">{thresholdPreviewError}</p>}
                  {thresholdPreview && !thresholdPreview.available && <p className="text-[11px] text-tx-4 mt-1 font-mono">No completed run found for this URL yet.</p>}
                  {thresholdPreview?.available && (
                    <div className={`mt-1 p-2.5 rounded-control border text-[11px] font-mono ${
                      thresholdPreview.perfStatus === 'failed' ? 'bg-red-bg border-red-fg/40 text-red-fg'
                      : thresholdPreview.perfStatus === 'degraded' ? 'bg-amber-bg border-amber-fg/40 text-amber-fg'
                      : 'bg-green-bg border-green-fg/40 text-green-fg'
                    }`}>
                      <p className="font-semibold">
                        {thresholdPreview.perfStatus === 'failed' ? '✗ Would fail' : thresholdPreview.perfStatus === 'degraded' ? '⚠ Degraded' : '✓ Would pass'}
                      </p>
                      {thresholdPreview.thresholdViolations && thresholdPreview.thresholdViolations.length > 0 && (
                        <ul className="list-disc list-inside mt-1">{thresholdPreview.thresholdViolations.map(v => <li key={v}>{v}</li>)}</ul>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {error && <p className="text-red-fg text-[12.5px]">{error}</p>}

            {isViewer ? (
              <p className="text-[12.5px] text-tx-4">Viewers cannot run tests or save presets.</p>
            ) : (
              <button onClick={handleSubmit} disabled={loading} data-run-btn
                className="bg-accent hover:bg-accent-hover text-white border-none rounded-[13px] py-3.5 text-[15px] font-bold font-sans flex items-center justify-center gap-2.5 cursor-pointer disabled:opacity-50 transition-colors">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="#fff"><path d="M4 3l9 5-9 5z" /></svg> {loading ? 'Creating…' : 'Run test'}
              </button>
            )}
            {!isViewer && (
              <button type="button" onClick={handleSavePreset} disabled={savingPreset} className="text-[12.5px] text-tx-3 hover:text-tx self-start disabled:opacity-50">
                {savingPreset ? 'Saving…' : 'Save as preset'}
              </button>
            )}
            {presetNameSuggestion && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[11px] text-tx-4 font-mono">✓ Saved as: <strong>{presetNameSuggestion.name}</strong></span>
                {presetNameSuggestion.tags.map(tag => <span key={tag} className="px-1.5 py-0.5 bg-bg text-tx-3 rounded-chip text-[10px] font-mono">{tag}</span>)}
              </div>
            )}
          </div>

          {/* Live + recent */}
          <div className="flex flex-col gap-5">
            {active.length > 0
              ? <LiveCard test={active[0]} />
              : (
                <div className="rounded-card p-5.5 text-tx-4 text-[13px] border border-dashed border-dashed">
                  No tests are running right now.
                </div>
              )}
            <RecentRuns recent={recent} />
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <Suspense fallback={<div className="p-6 text-tx-4 text-[13px]">Loading…</div>}>
      <HomeContent />
    </Suspense>
  );
}
