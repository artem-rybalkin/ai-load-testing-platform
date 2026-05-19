'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createTest, getTemplates, createTemplate, getResults, getActiveTests, Template, FlowStep, TestResult, ActiveTest } from '@/lib/api';
import FlowBuilder from '@/app/components/FlowBuilder';
import Link from 'next/link';

interface EnvVar { key: string; value: string }

interface Thresholds {
  p95: string; avg: string; errorRate: string;
  lcp: string; fcp: string; ttfb: string; cls: string;
}

const DEFAULT_THRESHOLDS: Thresholds = {
  p95: '1000', avg: '500', errorRate: '1',
  lcp: '2500', fcp: '1800', ttfb: '800', cls: '0.1',
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
                href={`/results/${t.test_id}`}
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
                href={`/results/${r.test_id}`}
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

function HomeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [showThresholds, setShowThresholds] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [thresholds, setThresholds] = useState<Thresholds>(DEFAULT_THRESHOLDS);
  const [recent, setRecent] = useState<TestResult[]>([]);
  const [active, setActive] = useState<ActiveTest[]>([]);
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
    profile: 'load' as 'load' | 'spike' | 'capacity' | 'soak'
  });
  const [flowSteps, setFlowSteps] = useState<FlowStep[]>([]);
  const [flowEnvVars, setFlowEnvVars] = useState<EnvVar[]>([]);

  const DURATION_OPTIONS = ['30s', '1m', '2m', '5m', '10m', '30m'];
  const toSecs = (d: string) => {
    const m = d.match(/^(\d+)(s|m|h)$/);
    if (!m) return 0;
    return parseInt(m[1]) * (m[2] === 'h' ? 3600 : m[2] === 'm' ? 60 : 1);
  };
  const snapDuration = (secs: number) =>
    DURATION_OPTIONS.reduce((best, opt) =>
      Math.abs(toSecs(opt) - secs) < Math.abs(toSecs(best) - secs) ? opt : best
    );

  const applyDescriptionParams = (desc: string) => {
    const updates: Partial<typeof form> = {};
    const vusM = desc.match(/\b(\d+)\s*(?:virtual\s+users?|vus?|users?|concurrent)\b/i);
    if (vusM) updates.vus = Math.min(100, Math.max(1, parseInt(vusM[1])));
    const sessM = desc.match(/\b(\d+)\s*(?:sessions?|browsers?|tabs?)\b/i);
    if (sessM) updates.sessions = Math.min(10, Math.max(1, parseInt(sessM[1])));
    const durM = desc.match(/\b(?:full\s+)?duration[:\s]+(\d+)\s*(minutes?|mins?|seconds?|secs?|hours?|hrs?|[smh])\b|\b(\d+)\s*(?:minute|min|second|sec|hour|hr)s?\s+(?:duration|test|long)\b|\bfor\s+(\d+)\s*(minutes?|mins?|seconds?|secs?|hours?|hrs?|[smh])\b/i);
    if (durM) {
      const n = parseInt(durM[1] ?? durM[3] ?? durM[4]);
      const u = (durM[2] ?? durM[5] ?? 'm').toLowerCase()[0];
      const secs = n * (u === 'h' ? 3600 : u === 'm' ? 60 : 1);
      updates.duration = snapDuration(secs);
    }
    const rampM = desc.match(/\bramp(?:\s*[-\s]?up)?[:\s]+(\d+)\s*(minutes?|mins?|seconds?|secs?|[sm])\b/i);
    if (rampM) {
      const n = parseInt(rampM[1]);
      const u = rampM[2].toLowerCase()[0];
      updates.rampUp = u === 'm' ? `${n}m` : `${n}s`;
    }
    if (/\bspike\b/i.test(desc)) updates.profile = 'spike';
    else if (/\bsoak\b/i.test(desc)) updates.profile = 'soak';
    else if (/\bcapacity\b/i.test(desc)) updates.profile = 'capacity';
    else if (/\bload\b/i.test(desc)) updates.profile = 'load';
    if (Object.keys(updates).length > 0) {
      setForm(f => ({ ...f, ...updates }));
    }
  };

  useEffect(() => {
    getTemplates().then(d => setTemplates(d.templates ?? [])).catch(() => {});
    getResults().then(d => setRecent(d.results?.slice(0, 10) ?? [])).catch(() => {});
    getActiveTests().then(d => setActive(d.active ?? [])).catch(() => {});

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

  const handleLoadTemplate = (id: string) => {
    if (!id) return;
    const t = templates.find(t => t.id === id);
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
      }));
      setShowThresholds(true);
    }
  };

  const handleSaveTemplate = async () => {
    if (!form.description && !form.targetUrl) { setError('Add a description or URL before saving as template'); return; }
    setSavingTemplate(true);
    try {
      const options = form.type === 'client-side'
        ? { sessions: form.sessions, duration: form.duration, collectWebVitals: form.collectWebVitals }
        : { vus: form.vus, duration: form.duration, profile: form.profile, peakVus: form.peakVus, ...(form.rampUp ? { rampUp: form.rampUp } : {}) };
      const savedThresholds = showThresholds ? buildThresholds() : null;
      await createTemplate({
        name: form.description || form.targetUrl || 'Unnamed test',
        description: form.description || null,
        type: form.type === 'flow' ? 'backend' : form.type,
        target_url: form.targetUrl || null,
        options,
        thresholds: savedThresholds ?? null,
      });
      const data = await getTemplates();
      setTemplates(data.templates ?? []);
    } finally {
      setSavingTemplate(false);
    }
  };

  const buildThresholds = () => {
    if (!showThresholds) return undefined;
    if (form.type === 'client-side') {
      return {
        ...(thresholds.lcp  ? { lcp:  Number(thresholds.lcp)  } : {}),
        ...(thresholds.fcp  ? { fcp:  Number(thresholds.fcp)  } : {}),
        ...(thresholds.ttfb ? { ttfb: Number(thresholds.ttfb) } : {}),
        ...(thresholds.cls  ? { cls:  Number(thresholds.cls)  } : {}),
      };
    }
    return {
      ...(thresholds.p95       ? { p95:       Number(thresholds.p95)       } : {}),
      ...(thresholds.avg       ? { avg:       Number(thresholds.avg)       } : {}),
      ...(thresholds.errorRate ? { errorRate: Number(thresholds.errorRate) } : {}),
    };
  };

  const handleSubmit = async () => {
    if (form.type === 'flow') {
      if (flowSteps.length === 0) { setError('Add at least one step to run a flow test'); return; }
      if (flowSteps.some(s => !s.url)) { setError('Every step must have a URL'); return; }
    } else if (!form.targetUrl) {
      setError('URL is required');
      return;
    }
    setLoading(true);
    setError('');

    try {
      if (form.type === 'flow') {
        const envVarsMap: Record<string, string> = {};
        for (const ev of flowEnvVars) { if (ev.key) envVarsMap[ev.key] = ev.value; }
        const res = await createTest({
          type: 'flow',
          targetUrl: flowSteps[0]?.url ?? '',
          description: form.description || `Flow test (${flowSteps.length} steps)`,
          options: { vus: form.vus, duration: form.duration, ...(form.rampUp ? { rampUp: form.rampUp } : {}) },
          steps: flowSteps,
          envVars: Object.keys(envVarsMap).length > 0 ? envVarsMap : undefined,
          thresholds: buildThresholds(),
        });
        if (res.test?.id) router.push(`/results/${res.test.id}`);
        return;
      }

      const options = form.type === 'backend'
        ? { vus: form.vus, duration: form.duration, profile: form.profile, peakVus: form.peakVus, ...(form.rampUp ? { rampUp: form.rampUp } : {}) }
        : { sessions: form.sessions, duration: form.duration, collectWebVitals: form.collectWebVitals };

      const res = await createTest({
        type: form.type,
        targetUrl: form.targetUrl,
        description: form.description || `${form.type} test for ${form.targetUrl}`,
        options,
        thresholds: buildThresholds(),
      });

      if (res.test?.id) router.push(`/results/${res.test.id}`);
    } catch {
      setError('Failed to create test');
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
            {templates.length > 0 && (
              <select
                value=""
                onChange={e => handleLoadTemplate(e.target.value)}
                className="text-[12px] border border-[#d0d7de] rounded-md px-2 py-1 bg-[#f6f8fa] text-[#57606a] focus:outline-none focus:border-[#0969da]"
              >
                <option value="" disabled>Load from template…</option>
                {templates.map(t => (
                  <option key={t.id} value={t.id}>{t.name} ({t.type})</option>
                ))}
              </select>
            )}
          </div>

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
                      onClick={() => setForm(f => ({ ...f, type: t.id }))}
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
                <FlowBuilder
                  steps={flowSteps}
                  envVars={flowEnvVars}
                  onChange={setFlowSteps}
                  onEnvVarsChange={setFlowEnvVars}
                />
              )}

              {/* URL */}
              {form.type !== 'flow' && (
                <div>
                  <label className="block text-[11px] font-semibold text-[#57606a] uppercase tracking-wide mb-1.5">Target URL</label>
                  <input
                    type="text"
                    placeholder="https://example.com"
                    value={form.targetUrl}
                    onChange={e => setForm(f => ({ ...f, targetUrl: e.target.value }))}
                    className={inputCls}
                  />
                </div>
              )}

              {/* Description */}
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
                  onBlur={e => applyDescriptionParams(e.target.value)}
                  className={inputCls}
                />
              </div>

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
                          {['30s', '1m', '2m', '5m', '10m', '30m'].map(d => (
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
                  </div>
                )}
              </div>

              {/* SLO thresholds */}
              <div>
                <button
                  type="button"
                  onClick={() => setShowThresholds(v => !v)}
                  className="flex items-center gap-1 text-[12px] text-[#57606a] hover:text-[#24292f] py-0.5"
                >
                  <span className={`transition-transform inline-block text-[10px] ${showThresholds ? 'rotate-90' : ''}`}>▶</span>
                  SLO thresholds
                  {showThresholds && <span className="text-[11px] text-[#0969da] ml-1">active</span>}
                </button>
                {showThresholds && (
                  <div className="mt-2 grid grid-cols-3 gap-2 p-3 bg-[#f6f8fa] rounded-md border border-[#d0d7de]">
                    {(form.type === 'client-side' ? [
                      { key: 'lcp',  label: 'LCP ms'  },
                      { key: 'fcp',  label: 'FCP ms'  },
                      { key: 'ttfb', label: 'TTFB ms' },
                      { key: 'cls',  label: 'CLS'     },
                    ] : [
                      { key: 'p95',       label: 'p95 ms'  },
                      { key: 'avg',       label: 'Avg ms'  },
                      { key: 'errorRate', label: 'Err %'   },
                    ] as const).map(({ key, label }) => (
                      <div key={key}>
                        <label className="block text-[10px] text-[#57606a] mb-1">{label} max</label>
                        <input
                          type="number" min={0}
                          value={(thresholds as Record<string, string>)[key]}
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
            <div className="px-4 py-3 bg-[#f6f8fa] border-t border-[#d0d7de] flex gap-2">
              <button
                onClick={handleSubmit}
                disabled={loading}
                className="flex-1 py-1.5 bg-[#1f883d] hover:bg-[#1a7f37] text-white rounded-md text-[13px] font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? 'Creating…' : '▶ Run Test'}
              </button>
              <button
                type="button"
                onClick={handleSaveTemplate}
                disabled={savingTemplate}
                className="px-3 py-1.5 border border-[#d0d7de] bg-white hover:bg-[#eaeef2] text-[#24292f] rounded-md text-[13px] disabled:opacity-50 transition-colors"
              >
                {savingTemplate ? 'Saving…' : 'Save template'}
              </button>
            </div>
          </div>
        </div>

        {/* ── Right: Quick stats panel ── */}
        <div className="hidden lg:block w-72 flex-shrink-0">
          <div className="mb-3">
            <h2 className="text-[15px] font-semibold text-[#24292f]">&nbsp;</h2>
          </div>
          <QuickStatsPanel active={active} recent={recent} />

          {/* Templates quick-access */}
          {templates.length > 0 && (
            <div className="mt-3 bg-white border border-[#d0d7de] rounded-md overflow-hidden">
              <div className="px-3 py-2 border-b border-[#d0d7de] bg-[#f6f8fa]">
                <span className="text-[11px] font-semibold text-[#57606a] uppercase tracking-wide">Templates</span>
              </div>
              <div className="divide-y divide-[#eaeef2]">
                {templates.slice(0, 5).map(t => (
                  <div key={t.id} className="flex items-center justify-between px-3 py-2">
                    <span className="font-mono text-[12px] text-[#24292f] truncate mr-2">{t.name}</span>
                    <button
                      onClick={() => handleLoadTemplate(t.id)}
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
