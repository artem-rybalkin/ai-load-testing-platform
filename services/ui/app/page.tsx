import { useState, useEffect, Suspense } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { createTest, getResult, getPresets, createPreset, getResults, getActiveTests, suggestThresholds, suggestSettings, translatePlaywright, suggestPresetName, Preset, FlowStep, TestResult, ActiveTest } from '@/lib/api';
import FlowBuilder from '@/app/components/FlowBuilder';
import { useAuth } from '@/lib/AuthContext';

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

function QuickStatsPanel({ active, recent }: { active: ActiveTest[]; recent: TestResult[] }) {
  const completed = recent.filter(r => r.status === 'completed');
  const passCount = completed.filter(r => r.perf_status === 'passed').length;
  const passRate = completed.length > 0 ? Math.round((passCount / completed.length) * 100) : null;
  const avgP95 = completed.length > 0 && completed[0]?.metrics?.p95ResponseTime != null
    ? Math.round(completed.reduce((s, r) => s + (r.metrics?.p95ResponseTime ?? 0), 0) / completed.length)
    : null;

  return (
    <div className="flex flex-col gap-3">
      {/* Stats */}
      <div className="bg-white border border-[#d0d7de] rounded-md overflow-hidden">
        <div className="px-3 py-2 border-b border-[#d0d7de] bg-[#f6f8fa]">
          <span className="text-[11px] font-semibold text-[#57606a] uppercase tracking-wide">Quick Stats</span>
        </div>
        <div className="divide-y divide-[#eaeef2]">
          <div className="flex justify-between items-center px-3 py-2 text-[13px]">
            <span className="text-[#57606a]">Tests today</span>
            <span className="font-mono font-semibold text-[#24292f]">{recent.length}</span>
          </div>
          {avgP95 !== null && (
            <div className="flex justify-between items-center px-3 py-2 text-[13px]">
              <span className="text-[#57606a]">Avg p95</span>
              <span className="font-mono font-semibold text-[#24292f]">{avgP95}ms</span>
            </div>
          )}
          {passRate !== null && (
            <div className="flex justify-between items-center px-3 py-2 text-[13px]">
              <span className="text-[#57606a]">Pass rate</span>
              <span className={`font-mono font-semibold ${passRate >= 80 ? 'text-[#1f883d]' : passRate >= 50 ? 'text-[#9a6700]' : 'text-[#cf222e]'}`}>
                {passRate}%
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Active */}
      {active.length > 0 && (
        <div className="bg-white border border-[#d0d7de] rounded-md overflow-hidden">
          <div className="px-3 py-2 border-b border-[#d0d7de] bg-[#f6f8fa]">
            <span className="text-[11px] font-semibold text-[#57606a] uppercase tracking-wide">Active Now</span>
          </div>
          <div className="divide-y divide-[#eaeef2]">
            {active.map(t => (
              <Link
                key={t.test_id}
                to={`/results/${t.test_id}`}
                className="flex items-center justify-between px-3 py-2 text-[12px] hover:bg-[#f6f8fa] group"
              >
                <span className="flex items-center gap-1.5 min-w-0">
                  <span className="w-1.5 h-1.5 bg-[#0969da] rounded-full animate-pulse flex-shrink-0" />
                  <span className="font-mono truncate text-[#24292f]">{t.target_url.replace(/https?:\/\//, '')}</span>
                </span>
                <span className="text-[#57606a] text-[10px] font-mono ml-2 flex-shrink-0">{t.type}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Recent */}
      {recent.length > 0 && (
        <div className="bg-white border border-[#d0d7de] rounded-md overflow-hidden">
          <div className="px-3 py-2 border-b border-[#d0d7de] bg-[#f6f8fa]">
            <span className="text-[11px] font-semibold text-[#57606a] uppercase tracking-wide">Recent</span>
          </div>
          <div className="divide-y divide-[#eaeef2]">
            {recent.slice(0, 5).map(r => (
              <Link
                key={r.id}
                to={`/results/${r.test_id}`}
                className="flex items-center justify-between px-3 py-2 text-[12px] hover:bg-[#f6f8fa]"
              >
                <span className="flex items-center gap-1.5 min-w-0">
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                    r.perf_status === 'passed' ? 'bg-[#1f883d]' :
                    r.perf_status === 'failed' ? 'bg-[#cf222e]' :
                    r.status === 'running' ? 'bg-[#0969da] animate-pulse' :
                    'bg-[#9a6700]'
                  }`} />
                  <span className="font-mono truncate text-[#24292f]">{r.target_url.replace(/https?:\/\//, '')}</span>
                </span>
                <span className="text-[#57606a] text-[10px] font-mono ml-2 flex-shrink-0">{relTime(r.created_at)}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
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
    httpHttp2: false,
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
    const isBrowser = /\b(browser|puppeteer|real\s+browser|web\s+vitals?|lighthouse|client[\s-]?side)\b/i.test(desc);
    const isBackend  = /\b(backend|api\s+test|load\s+test|http\s+test|k6|performance\s+test)\b/i.test(desc);
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

  useEffect(() => {
    getPresets().then(d => setPresets(d.presets ?? [])).catch(() => {});
    getResults().then(d => setRecent(d.results?.slice(0, 10) ?? [])).catch(() => {});
    getActiveTests().then(d => setActive(d.active ?? [])).catch(() => {});

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

    const type = searchParams.get('type') as 'backend' | 'client-side' | null;
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
    if (form.httpHttp2)      opts.http2 = true;
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

  const inputCls = "w-full border border-[#d0d7de] rounded-md px-3 py-1.5 text-[13px] bg-white text-[#24292f] focus:outline-none focus:border-[#0969da] focus:ring-2 focus:ring-[#0969da]/20 placeholder-[#8c959f]";

  return (
    <div className="p-4 lg:p-6">
      <div className="flex flex-col lg:flex-row gap-4 lg:gap-6 items-start">

        {/* ── Left: Test form ── */}
        <div className="w-full lg:flex-1 min-w-0">
          <div className="flex items-center justify-between mb-3">
            <h1 className="text-[15px] font-semibold text-[#24292f]">New Test</h1>
            {presets.length > 0 && (
              <select
                value=""
                onChange={e => handleLoadPreset(e.target.value)}
                className="text-[12px] border border-[#d0d7de] rounded-md px-2 py-1 bg-[#f6f8fa] text-[#57606a] focus:outline-none focus:border-[#0969da]"
              >
                <option value="" disabled>Load from preset…</option>
                {presets.map(t => (
                  <option key={t.id} value={t.id}>{t.name} ({t.type})</option>
                ))}
              </select>
            )}
          </div>

          {rerunFrom && (
            <div className="flex items-center justify-between px-3 py-2 mb-3 bg-[#ddf4ff] border border-[#c8e1ff] rounded-md text-[12px]">
              <span className="text-[#0969da]">
                ↻ Pre-filled from previous run of <span className="font-mono">{rerunFrom}</span> — script will be reused
              </span>
              <button
                onClick={() => setRerunFrom(null)}
                className="text-[#57606a] hover:text-[#24292f] ml-3 flex-shrink-0"
                aria-label="Dismiss re-run notice"
              >
                ✕
              </button>
            </div>
          )}

          <div className="bg-white border border-[#d0d7de] rounded-md overflow-hidden">
            <div className="p-4 space-y-4">

              {/* Test type */}
              <div>
                <label className="block text-[11px] font-semibold text-[#57606a] uppercase tracking-wide mb-1.5">Test type</label>
                <div className="flex border border-[#d0d7de] rounded-md overflow-hidden">
                  {([
                    { id: 'backend',     label: '⚡ Backend'        },
                    { id: 'client-side', label: '🌐 Browser'        },
                    { id: 'flow',        label: '🔗 Multi-step Flow' },
                  ] as const).map((t, i) => (
                    <button
                      key={t.id}
                      onClick={() => {
                        if (t.id !== form.type) {
                          setThresholds(DEFAULT_THRESHOLDS);
                          setThresholdSuggestionNote(null);
                        }
                        setForm(f => ({ ...f, type: t.id }));
                        if (t.id !== 'backend') { setScriptMode('ai'); setCustomScript(''); }
                      }}
                      className={`flex-1 py-1.5 text-[13px] font-medium transition-colors ${i > 0 ? 'border-l border-[#d0d7de]' : ''} ${
                        form.type === t.id
                          ? 'bg-white text-[#0969da]'
                          : 'bg-[#f6f8fa] text-[#57606a] hover:bg-[#eaeef2]'
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Flow builder */}
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
                  />
                  {/* Runner selector */}
                  <div>
                    <label className="block text-[11px] font-semibold text-[#57606a] uppercase tracking-wide mb-1.5">Run as</label>
                    <div className="flex border border-[#d0d7de] rounded-md overflow-hidden w-fit">
                      {([
                        { id: 'k6',      label: '⚡ k6 HTTP',          desc: 'Load test with many virtual users' },
                        { id: 'browser', label: '🌐 Puppeteer Browser', desc: 'Real browser, Web Vitals, Lighthouse' },
                      ] as const).map((r, i) => (
                        <button
                          key={r.id}
                          type="button"
                          title={r.desc}
                          onClick={() => setFlowRunner(r.id)}
                          className={`px-3 py-1.5 text-[13px] font-medium transition-colors ${i > 0 ? 'border-l border-[#d0d7de]' : ''} ${
                            flowRunner === r.id
                              ? 'bg-white text-[#0969da]'
                              : 'bg-[#f6f8fa] text-[#57606a] hover:bg-[#eaeef2]'
                          }`}
                        >
                          {r.label}
                        </button>
                      ))}
                    </div>
                    {flowRunner === 'browser' && (
                      <p className="mt-1 text-[11px] text-[#57606a]">
                        Launches a real Chromium browser. Collects Web Vitals &amp; Lighthouse scores. Uses <strong>sessions</strong> and <strong>duration</strong> from Advanced settings.
                      </p>
                    )}
                  </div>
                </>
              )}

              {/* URL */}
              {form.type !== 'flow' && (
                <div>
                  <label className="block text-[11px] font-semibold text-[#57606a] uppercase tracking-wide mb-1.5">
                    Target URL
                    {form.type === 'backend' && scriptMode === 'custom' && (
                      <span className="ml-1 text-[#8c959f] normal-case font-normal tracking-normal">(optional — used as result label)</span>
                    )}
                  </label>
                  <input
                    type="text"
                    placeholder={form.type === 'backend' && scriptMode === 'custom' ? 'https://example.com (auto-detected from script if blank)' : 'https://example.com'}
                    value={form.targetUrl}
                    onChange={e => setForm(f => ({ ...f, targetUrl: e.target.value }))}
                    className={inputCls}
                  />
                  {form.targetUrl && (
                    <div className="mt-1 flex items-center gap-2">
                      <button type="button" onClick={handleSuggestSettings} disabled={suggestingSettings}
                        className="text-[11px] text-[#0969da] hover:underline disabled:opacity-50 font-mono">
                        {suggestingSettings ? '⏳ Analysing…' : '✨ Suggest settings'}
                      </button>
                      {settingsSuggestionNote && (
                        <span className="text-[11px] text-[#57606a] font-mono truncate">{settingsSuggestionNote}</span>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Script source toggle — backend only */}
              {form.type === 'backend' && (
                <div>
                  <label className="block text-[11px] font-semibold text-[#57606a] uppercase tracking-wide mb-1.5">Script source</label>
                  <div className="flex border border-[#d0d7de] rounded-md overflow-hidden w-fit">
                    {([
                      { id: 'ai',     label: '🤖 AI Generate'  },
                      { id: 'custom', label: '📄 Custom Script' },
                    ] as const).map((s, i) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setScriptMode(s.id)}
                        className={`px-3 py-1.5 text-[13px] font-medium transition-colors ${i > 0 ? 'border-l border-[#d0d7de]' : ''} ${
                          scriptMode === s.id
                            ? 'bg-white text-[#0969da]'
                            : 'bg-[#f6f8fa] text-[#57606a] hover:bg-[#eaeef2]'
                        }`}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Custom k6 script — textarea + file upload */}
              {form.type === 'backend' && scriptMode === 'custom' && (
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="block text-[11px] font-semibold text-[#57606a] uppercase tracking-wide">k6 Script</label>
                    <div className="flex items-center gap-3">
                      <label className="text-[11px] font-mono text-[#0969da] hover:underline cursor-pointer">
                        ↑ Upload .js
                        <input type="file" accept=".js,.ts" className="hidden"
                          onChange={async (e) => {
                            const file = e.target.files?.[0]; if (!file) return;
                            setCustomScript(await file.text()); e.target.value = '';
                          }} />
                      </label>
                      <label className={`text-[11px] font-mono cursor-pointer ${translating ? 'text-[#57606a]' : 'text-[#0969da] hover:underline'}`}
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
                  <p className="text-[10px] text-[#8c959f] mt-1">Max 512 KB · The script&apos;s own <code className="font-mono">export const options</code> overrides Advanced settings.</p>
                </div>
              )}

              {/* Description — hidden in custom script mode */}
              {!(form.type === 'backend' && scriptMode === 'custom') && (
              <div>
                <label className="block text-[11px] font-semibold text-[#57606a] uppercase tracking-wide mb-1.5">
                  What to test?{' '}
                  <span className="text-[#8c959f] normal-case font-normal tracking-normal">(AI parses VUs, duration, profile)</span>
                </label>
                <input
                  type="text"
                  placeholder="e.g. load test with 10 users for 2 minutes, ramp up 30s..."
                  value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  onBlur={e => {
                    // Skip if focus is moving to the Run Test button — avoid opening
                    // Advanced Settings mid-submit which confuses users
                    const relatedTarget = e.relatedTarget as HTMLElement | null;
                    if (relatedTarget?.closest('[data-run-btn]')) return;
                    applyDescriptionParams(e.target.value);
                  }}
                  className={inputCls}
                />
              </div>
              )}

              {/* Advanced settings */}
              <div>
                <button
                  type="button"
                  onClick={() => setShowAdvanced(v => !v)}
                  className="flex items-center gap-1 text-[12px] text-[#57606a] hover:text-[#24292f] py-0.5"
                >
                  <span className={`transition-transform inline-block text-[10px] ${showAdvanced ? 'rotate-90' : ''}`}>▶</span>
                  Advanced settings
                  {!showAdvanced && (
                    <span className="text-[11px] text-[#8c959f] ml-1 font-mono">
                      {form.type === 'client-side'
                        ? `${form.sessions} sessions · ${form.duration}`
                        : `${form.vus} VUs · ${form.duration}${form.rampUp ? ` · ramp ${form.rampUp}` : ''}${form.type === 'backend' ? ` · ${form.profile}` : ''}`}
                    </span>
                  )}
                </button>
                {showAdvanced && (
                  <div className="mt-2 space-y-3 p-3 bg-[#f6f8fa] rounded-md border border-[#d0d7de]">
                    {form.type === 'backend' && (
                      <div>
                        <label className="block text-[11px] font-semibold text-[#57606a] mb-1.5">Load profile</label>
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
                              className={`py-1.5 px-2.5 rounded-md border text-left transition-colors ${
                                form.profile === p.id
                                  ? 'border-[#0969da] bg-[#ddf4ff]'
                                  : 'border-[#d0d7de] bg-white hover:bg-[#eaeef2]'
                              }`}
                            >
                              <div className="text-[12px] font-medium text-[#24292f]">{p.label}</div>
                              <div className="text-[10px] text-[#8c959f]">{p.hint}</div>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-3">
                      {form.type === 'client-side' ? (
                        <div>
                          <label className="block text-[11px] text-[#57606a] mb-1">Browser sessions</label>
                          <input type="number" min={1} max={10} value={form.sessions}
                            onChange={e => setForm(f => ({ ...f, sessions: Number(e.target.value) }))}
                            className={inputCls}
                          />
                        </div>
                      ) : (
                        <div>
                          <label className="block text-[11px] text-[#57606a] mb-1">
                            {form.profile === 'spike' || form.profile === 'capacity' ? 'Baseline VUs' : 'Virtual users'}
                          </label>
                          <input type="number" min={1} max={100} value={form.vus}
                            onChange={e => setForm(f => ({ ...f, vus: Number(e.target.value) }))}
                            className={inputCls}
                          />
                        </div>
                      )}
                      <div>
                        <label className="block text-[11px] text-[#57606a] mb-1">Duration</label>
                        <select value={form.duration} onChange={e => setForm(f => ({ ...f, duration: e.target.value }))}
                          className={inputCls}
                        >
                          {DURATION_OPTIONS.map(d => (
                            <option key={d} value={d}>{d}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                    {form.type !== 'client-side' && (
                      <div>
                        <label className="block text-[11px] text-[#57606a] mb-1">Ramp-up <span className="text-[#8c959f]">(optional, e.g. 30s, 1m)</span></label>
                        <input type="text" placeholder="30s" value={form.rampUp}
                          onChange={e => setForm(f => ({ ...f, rampUp: e.target.value }))}
                          className={inputCls}
                        />
                      </div>
                    )}
                    {form.type === 'backend' && (form.profile === 'spike' || form.profile === 'capacity') && (
                      <div>
                        <label className="block text-[11px] text-[#57606a] mb-1">
                          {form.profile === 'spike' ? 'Peak VUs (spike target)' : 'Max VUs (capacity ceiling)'}
                        </label>
                        <input type="number" min={form.vus + 1} max={500} value={form.peakVus}
                          onChange={e => setForm(f => ({ ...f, peakVus: Number(e.target.value) }))}
                          className={inputCls}
                        />
                      </div>
                    )}

                    {/* HTTP settings — backend/flow only */}
                    {form.type !== 'client-side' && (
                      <div className="pt-2 border-t border-[#eaeef2]">
                        <label className="block text-[11px] font-semibold text-[#57606a] uppercase tracking-wide mb-2">HTTP Settings</label>
                        <div className="space-y-2">
                          <label className="flex items-center gap-2 text-[12px] text-[#24292f] cursor-pointer">
                            <input type="checkbox" checked={form.httpKeepAlive}
                              onChange={e => setForm(f => ({ ...f, httpKeepAlive: e.target.checked }))}
                              className="rounded-sm border-[#d0d7de]"
                            />
                            Keep-alive connections
                          </label>
                          <label className="flex items-center gap-2 text-[12px] text-[#24292f] cursor-pointer">
                            <input type="checkbox" checked={form.httpHttp2}
                              onChange={e => setForm(f => ({ ...f, httpHttp2: e.target.checked }))}
                              className="rounded-sm border-[#d0d7de]"
                            />
                            Force HTTP/2
                          </label>
                          <label className="flex items-center gap-2 text-[12px] text-[#24292f] cursor-pointer">
                            <input type="checkbox" checked={form.httpDiscardBodies}
                              onChange={e => setForm(f => ({ ...f, httpDiscardBodies: e.target.checked }))}
                              className="rounded-sm border-[#d0d7de]"
                            />
                            Discard response bodies <span className="text-[#8c959f]">(faster, saves memory)</span>
                          </label>
                          <div>
                            <label className="block text-[11px] text-[#57606a] mb-1">Request timeout <span className="text-[#8c959f]">(e.g. 30s, 1m)</span></label>
                            <input type="text" placeholder="30s" value={form.httpTimeout}
                              onChange={e => setForm(f => ({ ...f, httpTimeout: e.target.value }))}
                              className={inputCls}
                            />
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Custom headers — backend/browser only */}
                    {form.type !== 'flow' && (
                      <div className="pt-2 border-t border-[#eaeef2]">
                        <div className="flex items-center justify-between mb-1">
                          <label className="block text-[11px] font-semibold text-[#57606a] uppercase tracking-wide">Custom Headers</label>
                          <button type="button" onClick={() => setCustomHeaders(h => [...h, { key: '', value: '' }])} className="text-xs text-blue-600 hover:underline">+ add</button>
                        </div>
                        {customHeaders.map((h, i) => (
                          <div key={i} className="flex gap-1 mb-1 items-center">
                            <input
                              type="text"
                              placeholder="Header-Name"
                              value={h.key}
                              onChange={e => setCustomHeaders(hs => hs.map((x, j) => j === i ? { ...x, key: e.target.value } : x))}
                              className="w-40 border border-[#d0d7de] rounded px-2 py-0.5 text-xs font-mono focus:outline-none focus:border-[#0969da]"
                            />
                            <span className="text-[#8c959f] text-xs">:</span>
                            <input
                              type="text"
                              placeholder="value"
                              value={h.value}
                              onChange={e => setCustomHeaders(hs => hs.map((x, j) => j === i ? { ...x, value: e.target.value } : x))}
                              className="flex-1 border border-[#d0d7de] rounded px-2 py-0.5 text-xs font-mono focus:outline-none focus:border-[#0969da]"
                            />
                            <button type="button" onClick={() => setCustomHeaders(hs => hs.filter((_, j) => j !== i))} className="text-[#8c959f] hover:text-[#cf222e] text-xs">✕</button>
                          </div>
                        ))}
                        {customHeaders.length === 0 && (
                          <p className="text-xs text-[#8c959f]">No custom headers. Sent with every request (e.g. API keys, auth tokens).</p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* SLO thresholds */}
              <div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowThresholds(v => !v)}
                    className="flex items-center gap-1 text-[12px] text-[#57606a] hover:text-[#24292f] py-0.5"
                  >
                    <span className={`transition-transform inline-block text-[10px] ${showThresholds ? 'rotate-90' : ''}`}>▶</span>
                    SLO thresholds
                    {showThresholds && <span className="text-[11px] text-[#0969da] ml-1">active</span>}
                  </button>
                  {form.targetUrl && form.type !== 'flow' && (
                    <button
                      type="button"
                      onClick={handleSuggestThresholds}
                      disabled={suggestingThresholds}
                      className="text-[11px] text-[#0969da] hover:underline disabled:opacity-50 font-mono"
                      title="Analyse run history and suggest realistic SLO values"
                    >
                      {suggestingThresholds ? '⏳ Analysing…' : '✨ Suggest'}
                    </button>
                  )}
                </div>
                {thresholdSuggestionNote && (
                  <p className="text-[11px] text-[#57606a] mt-1 font-mono">{thresholdSuggestionNote}</p>
                )}
                {showThresholds && (
                  <div className="mt-2 grid grid-cols-3 gap-2 p-3 bg-[#f6f8fa] rounded-md border border-[#d0d7de]">
                    {(form.type === 'client-side' ? [
                      { key: 'lcp',  label: 'LCP ms'  },
                      { key: 'fcp',  label: 'FCP ms'  },
                      { key: 'ttfb', label: 'TTFB ms' },
                      { key: 'cls',  label: 'CLS'     },
                      { key: 'inp',  label: 'INP ms'  },
                      { key: 'tbt',  label: 'TBT ms'  },
                    ] : [
                      { key: 'p95',             label: 'p95 ms'     },
                      { key: 'avg',             label: 'Avg ms'     },
                      { key: 'errorRate',       label: 'Err %'      },
                      { key: 'serverErrorRate', label: '5xx err %'  },
                      { key: 'timeoutRate',     label: 'Timeout %'  },
                    ] as const).map(({ key, label }) => (
                      <div key={key}>
                        <label className="block text-[10px] text-[#57606a] mb-1">{label} max</label>
                        <input
                          type="number" min={0}
                          value={(thresholds as unknown as Record<string, string>)[key]}
                          onChange={e => setThresholds(t => ({ ...t, [key]: e.target.value }))}
                          className={inputCls}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {error && <p className="text-[#cf222e] text-[12px]">{error}</p>}
            </div>

            {/* Action buttons */}
            {isViewer ? (
              <div className="px-4 py-3 bg-[#f6f8fa] border-t border-[#d0d7de] text-[12px] text-[#57606a]">
                Viewers cannot run tests or save presets.
              </div>
            ) : (
              <div className="px-4 py-3 bg-[#f6f8fa] border-t border-[#d0d7de] flex gap-2">
                <button
                  onClick={handleSubmit}
                  disabled={loading}
                  data-run-btn
                  className="flex-1 py-1.5 bg-[#1f883d] hover:bg-[#1a7f37] text-white rounded-md text-[13px] font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {loading ? 'Creating…' : '▶ Run Test'}
                </button>
                <button
                  type="button"
                  onClick={handleSavePreset}
                  disabled={savingPreset}
                  className="px-3 py-1.5 border border-[#d0d7de] bg-white hover:bg-[#eaeef2] text-[#24292f] rounded-md text-[13px] disabled:opacity-50 transition-colors"
                >
                  {savingPreset ? 'Saving…' : 'Save preset'}
                </button>
              </div>
            )}
            {presetNameSuggestion && (
              <div className="px-4 pb-2 flex items-center gap-2 flex-wrap">
                <span className="text-[11px] text-[#57606a] font-mono">✓ Saved as: <strong>{presetNameSuggestion.name}</strong></span>
                {presetNameSuggestion.tags.map(tag => (
                  <span key={tag} className="px-1.5 py-0.5 bg-[#eaeef2] text-[#57606a] rounded text-[10px] font-mono">{tag}</span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── Right: Quick stats panel ── */}
        <div className="hidden lg:block w-72 flex-shrink-0">
          <div className="mb-3">
            <h2 className="text-[15px] font-semibold text-[#24292f]">&nbsp;</h2>
          </div>
          <QuickStatsPanel active={active} recent={recent} />

          {/* Presets quick-access */}
          {presets.length > 0 && (
            <div className="mt-3 bg-white border border-[#d0d7de] rounded-md overflow-hidden">
              <div className="px-3 py-2 border-b border-[#d0d7de] bg-[#f6f8fa]">
                <span className="text-[11px] font-semibold text-[#57606a] uppercase tracking-wide">Presets</span>
              </div>
              <div className="divide-y divide-[#eaeef2]">
                {presets.slice(0, 5).map(t => (
                  <div key={t.id} className="flex items-center justify-between px-3 py-2">
                    <span className="font-mono text-[12px] text-[#24292f] truncate mr-2">{t.name}</span>
                    <button
                      onClick={() => handleLoadPreset(t.id)}
                      className="text-[11px] text-[#0969da] hover:underline flex-shrink-0"
                    >
                      [Use]
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

export default function Home() {
  return (
    <Suspense fallback={<div className="p-6 text-[#57606a] text-[13px]">Loading…</div>}>
      <HomeContent />
    </Suspense>
  );
}
