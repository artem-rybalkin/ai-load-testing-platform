'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createTest, getTemplates, createTemplate, Template, FlowStep } from '@/lib/api';
import FlowBuilder from '@/app/components/FlowBuilder';

interface EnvVar { key: string; value: string }

interface Thresholds {
  p95: string; avg: string; errorRate: string;
  lcp: string; fcp: string; ttfb: string; cls: string;
}

const DEFAULT_THRESHOLDS: Thresholds = {
  p95: '1000', avg: '500', errorRate: '1',
  lcp: '2500', fcp: '1800', ttfb: '800', cls: '0.1',
};

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
      setShowAdvanced(true);
    }
  };

  useEffect(() => {
    getTemplates().then(d => setTemplates(d.templates ?? [])).catch(() => {});
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
        ...(type        ? { type }                  : {}),
        ...(targetUrl   ? { targetUrl }             : {}),
        ...(description ? { description }           : {}),
        ...(vus         ? { vus: Number(vus) }      : {}),
        ...(sessions    ? { sessions: Number(sessions) } : {}),
        ...(duration    ? { duration }              : {}),
        ...(profile     ? { profile }               : {}),
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
      ...(t.target_url                ? { targetUrl: t.target_url }              : {}),
      ...((t.description ?? t.name)    ? { description: t.description ?? t.name } : {}),
      ...(opts.vus                    ? { vus: Number(opts.vus) }                : {}),
      ...(opts.peakVus                ? { peakVus: Number(opts.peakVus) }        : {}),
      ...(opts.sessions               ? { sessions: Number(opts.sessions) }      : {}),
      ...(opts.duration               ? { duration: String(opts.duration) }      : {}),
      ...(opts.profile                ? { profile: opts.profile as typeof f.profile } : {}),
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
        : { vus: form.vus, duration: form.duration, profile: form.profile, peakVus: form.peakVus };
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

      if (res.test?.id) {
        router.push(`/results/${res.test.id}`);
      }
    } catch {
      setError('Failed to create test');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-2xl mx-auto">

        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">AI Load Testing Platform</h1>
          <p className="text-gray-500 mt-1">AI-powered performance testing for backend APIs and browser</p>
        </div>

        {templates.length > 0 && (
          <div className="mb-4">
            <select
              value=""
              onChange={e => handleLoadTemplate(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            >
              <option value="" disabled>Load from template…</option>
              {templates.map(t => (
                <option key={t.id} value={t.id}>{t.name} ({t.type})</option>
              ))}
            </select>
          </div>
        )}

        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 space-y-5">

          {/* Test type */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Test type</label>
            <div className="grid grid-cols-3 gap-3">
              {([
                { id: 'backend',     label: '⚡ Backend / API' },
                { id: 'client-side', label: '🌐 Browser' },
                { id: 'flow',        label: '🔗 Multi-step Flow' },
              ] as const).map(t => (
                <button
                  key={t.id}
                  onClick={() => setForm(f => ({ ...f, type: t.id }))}
                  className={`py-3 px-4 rounded-lg border-2 text-sm font-medium transition-all ${
                    form.type === t.id
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-gray-200 text-gray-600 hover:border-gray-300'
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

          {/* URL — only for non-flow */}
          {form.type !== 'flow' && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Target URL</label>
            <input
              type="url"
              placeholder="https://example.com"
              value={form.targetUrl}
              onChange={e => setForm(f => ({ ...f, targetUrl: e.target.value }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          )}

          {/* Description — primary input */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">What do you want to test?</label>
            <input
              type="text"
              placeholder="e.g. load test with 10 users for 2 minutes, ramp up 30s..."
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              onBlur={e => applyDescriptionParams(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-xs text-gray-400 mt-1">Mention VUs, duration, ramp-up or profile and they'll be applied automatically</p>
          </div>

          {/* Advanced settings */}
          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced(v => !v)}
              className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700"
            >
              <span className={`transition-transform inline-block ${showAdvanced ? 'rotate-90' : ''}`}>▶</span>
              Advanced settings
              {!showAdvanced && (
                <span className="text-xs text-gray-400 ml-1">
                  {form.type === 'client-side'
                    ? `${form.sessions} sessions · ${form.duration}`
                    : `${form.vus} VUs · ${form.duration}${form.rampUp ? ` · ramp ${form.rampUp}` : ''}${form.type === 'backend' ? ` · ${form.profile}` : ''}`}
                </span>
              )}
            </button>
            {showAdvanced && (
              <div className="mt-3 space-y-4 p-4 bg-gray-50 rounded-lg border border-gray-200">
                {/* Load profile (backend only) */}
                {form.type === 'backend' && (
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-2">Load profile</label>
                    <div className="grid grid-cols-2 gap-2">
                      {([
                        { id: 'load',     label: 'Load',     hint: 'Constant VUs' },
                        { id: 'spike',    label: 'Spike',    hint: 'Sudden traffic burst' },
                        { id: 'capacity', label: 'Capacity', hint: 'Ramp until breakpoint' },
                        { id: 'soak',     label: 'Soak',     hint: 'Long steady-state' },
                      ] as const).map(p => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => setForm(f => ({ ...f, profile: p.id }))}
                          className={`py-2 px-3 rounded-lg border-2 text-left transition-all ${
                            form.profile === p.id
                              ? 'border-blue-500 bg-blue-50'
                              : 'border-gray-200 bg-white hover:border-gray-300'
                          }`}
                        >
                          <div className="text-sm font-medium text-gray-800">{p.label}</div>
                          <div className="text-xs text-gray-400">{p.hint}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* VUs / sessions + duration */}
                <div className="grid grid-cols-2 gap-4">
                  {form.type === 'client-side' ? (
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Browser sessions</label>
                      <input type="number" min={1} max={10} value={form.sessions}
                        onChange={e => setForm(f => ({ ...f, sessions: Number(e.target.value) }))}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                      />
                    </div>
                  ) : (
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">
                        {form.profile === 'spike' || form.profile === 'capacity' ? 'Baseline VUs' : 'Virtual users'}
                      </label>
                      <input type="number" min={1} max={100} value={form.vus}
                        onChange={e => setForm(f => ({ ...f, vus: Number(e.target.value) }))}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                      />
                    </div>
                  )}
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Duration</label>
                    <select value={form.duration} onChange={e => setForm(f => ({ ...f, duration: e.target.value }))}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                    >
                      {['30s', '1m', '2m', '5m', '10m', '30m'].map(d => (
                        <option key={d} value={d}>{d}</option>
                      ))}
                    </select>
                  </div>
                </div>
                {form.type !== 'client-side' && (
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Ramp-up <span className="text-gray-400 font-normal">(optional, e.g. 30s, 1m)</span></label>
                    <input type="text" placeholder="30s"
                      value={form.rampUp}
                      onChange={e => setForm(f => ({ ...f, rampUp: e.target.value }))}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                    />
                  </div>
                )}
                {/* Peak VUs — spike and capacity only */}
                {form.type === 'backend' && (form.profile === 'spike' || form.profile === 'capacity') && (
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      {form.profile === 'spike' ? 'Peak VUs (spike target)' : 'Max VUs (capacity ceiling)'}
                    </label>
                    <input type="number" min={form.vus + 1} max={500} value={form.peakVus}
                      onChange={e => setForm(f => ({ ...f, peakVus: Number(e.target.value) }))}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
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
              className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700"
            >
              <span className={`transition-transform ${showThresholds ? 'rotate-90' : ''}`}>▶</span>
              SLO thresholds
              {showThresholds && <span className="text-xs text-blue-500 ml-1">active</span>}
            </button>
            {showThresholds && (
              <div className="mt-3 grid grid-cols-3 gap-3 p-4 bg-gray-50 rounded-lg border border-gray-200">
                {form.type === 'client-side' ? (
                  <>
                    {([
                      { key: 'lcp',  label: 'LCP',  unit: 'ms' },
                      { key: 'fcp',  label: 'FCP',  unit: 'ms' },
                      { key: 'ttfb', label: 'TTFB', unit: 'ms' },
                      { key: 'cls',  label: 'CLS',  unit: 'score' },
                    ] as const).map(({ key, label, unit }) => (
                      <div key={key}>
                        <label className="block text-xs text-gray-500 mb-1">{label} max <span className="text-gray-400">({unit})</span></label>
                        <input
                          type="number" min={0} step={key === 'cls' ? 0.01 : 1}
                          value={thresholds[key]}
                          onChange={e => setThresholds(t => ({ ...t, [key]: e.target.value }))}
                          className="w-full border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                    ))}
                  </>
                ) : (
                  <>
                    {([
                      { key: 'p95',       label: 'p95',        unit: 'ms' },
                      { key: 'avg',       label: 'Avg',        unit: 'ms' },
                      { key: 'errorRate', label: 'Error rate', unit: '%'  },
                    ] as const).map(({ key, label, unit }) => (
                      <div key={key}>
                        <label className="block text-xs text-gray-500 mb-1">{label} max <span className="text-gray-400">({unit})</span></label>
                        <input
                          type="number" min={0} step={key === 'errorRate' ? 0.1 : 1}
                          value={thresholds[key]}
                          onChange={e => setThresholds(t => ({ ...t, [key]: e.target.value }))}
                          className="w-full border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>

          {error && <p className="text-red-500 text-sm">{error}</p>}

          <button
            onClick={handleSubmit}
            disabled={loading}
            className="w-full py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? 'Creating test...' : 'Run test'}
          </button>
          <button
            type="button"
            onClick={handleSaveTemplate}
            disabled={savingTemplate}
            className="w-full py-2 border border-gray-300 text-gray-600 rounded-lg text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
          >
            {savingTemplate ? 'Saving…' : 'Save as template'}
          </button>
        </div>

        <div className="mt-4 text-center">
          <a href="/results" className="text-sm text-blue-600 hover:underline">
            View all results →
          </a>
        </div>
      </div>
    </main>
  );
}

export default function Home() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-gray-50" />}>
      <HomeContent />
    </Suspense>
  );
}