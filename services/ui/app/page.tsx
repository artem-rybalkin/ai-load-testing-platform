'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createTest, getTemplates, createTemplate, Template, FlowStep } from '@/lib/api';
import FlowBuilder from '@/app/components/FlowBuilder';

interface EnvVar { key: string; value: string }

function HomeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [form, setForm] = useState({
    type: 'backend' as 'backend' | 'client-side' | 'flow',
    targetUrl: '',
    description: '',
    vus: 5,
    peakVus: 50,
    sessions: 2,
    duration: '30s',
    collectWebVitals: true,
    profile: 'load' as 'load' | 'spike' | 'capacity' | 'soak'
  });
  const [flowSteps, setFlowSteps] = useState<FlowStep[]>([]);
  const [flowEnvVars, setFlowEnvVars] = useState<EnvVar[]>([]);

  useEffect(() => {
    getTemplates().then(d => setTemplates(d.templates ?? [])).catch(() => {});
    const type = searchParams.get('type') as 'backend' | 'client-side' | null;
    const targetUrl = searchParams.get('targetUrl');
    const description = searchParams.get('description');
    const vus = searchParams.get('vus');
    const sessions = searchParams.get('sessions');
    const duration = searchParams.get('duration');
    if (type || targetUrl) {
      setForm(f => ({
        ...f,
        ...(type ? { type } : {}),
        ...(targetUrl ? { targetUrl } : {}),
        ...(description ? { description } : {}),
        ...(vus ? { vus: Number(vus) } : {}),
        ...(sessions ? { sessions: Number(sessions) } : {}),
        ...(duration ? { duration } : {}),
      }));
    }
  }, [searchParams]);

  const handleLoadTemplate = (id: string) => {
    const t = templates.find(t => t.id === id);
    if (!t) return;
    const opts = t.options as Record<string, unknown>;
    setForm(f => ({
      ...f,
      type: t.type as 'backend' | 'client-side' | 'flow',
      ...(t.target_url ? { targetUrl: t.target_url } : {}),
      ...(t.description ? { description: t.description } : {}),
      ...(opts.vus ? { vus: Number(opts.vus) } : {}),
      ...(opts.sessions ? { sessions: Number(opts.sessions) } : {}),
      ...(opts.duration ? { duration: String(opts.duration) } : {}),
    }));
  };

  const handleSaveTemplate = async () => {
    if (!form.description && !form.targetUrl) { setError('Add a description or URL before saving as template'); return; }
    setSavingTemplate(true);
    try {
      const options = form.type === 'backend'
        ? { vus: form.vus, duration: form.duration }
        : form.type === 'flow'
          ? { vus: form.vus, duration: form.duration }
          : { sessions: form.sessions, duration: form.duration, collectWebVitals: form.collectWebVitals };
      await createTemplate({
        name: form.description || form.targetUrl,
        description: null,
        type: form.type === 'flow' ? 'backend' : form.type,
        target_url: form.targetUrl || null,
        options,
        thresholds: null,
      });
      const data = await getTemplates();
      setTemplates(data.templates ?? []);
    } finally {
      setSavingTemplate(false);
    }
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
          options: { vus: form.vus, duration: form.duration },
          steps: flowSteps,
          envVars: Object.keys(envVarsMap).length > 0 ? envVarsMap : undefined,
        });
        if (res.test?.id) router.push(`/results/${res.test.id}`);
        return;
      }

      const options = form.type === 'backend'
        ? { vus: form.vus, duration: form.duration, profile: form.profile, peakVus: form.peakVus }
        : { sessions: form.sessions, duration: form.duration, collectWebVitals: form.collectWebVitals };

      const res = await createTest({
        type: form.type,
        targetUrl: form.targetUrl,
        description: form.description || `${form.type} test for ${form.targetUrl}`,
        options
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
              onChange={e => handleLoadTemplate(e.target.value)}
              defaultValue=""
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

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description (optional)</label>
            <input
              type="text"
              placeholder="Describe what you want to test..."
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Load profile (backend only) */}
          {form.type === 'backend' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Load profile</label>
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
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <div className="text-sm font-medium text-gray-800">{p.label}</div>
                    <div className="text-xs text-gray-400">{p.hint}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Options */}
          <div className="grid grid-cols-2 gap-4">
            {form.type === 'client-side' ? (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Browser sessions</label>
                <input
                  type="number"
                  min={1} max={10}
                  value={form.sessions}
                  onChange={e => setForm(f => ({ ...f, sessions: Number(e.target.value) }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            ) : (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {form.type === 'flow' ? 'Virtual users' : form.profile === 'spike' || form.profile === 'capacity' ? 'Baseline VUs' : 'Virtual users'}
                </label>
                <input
                  type="number"
                  min={1} max={100}
                  value={form.vus}
                  onChange={e => setForm(f => ({ ...f, vus: Number(e.target.value) }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Duration</label>
              <select
                value={form.duration}
                onChange={e => setForm(f => ({ ...f, duration: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {['30s', '1m', '2m', '5m', '10m', '30m'].map(d => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Peak VUs — spike and capacity only */}
          {form.type === 'backend' && (form.profile === 'spike' || form.profile === 'capacity') && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {form.profile === 'spike' ? 'Peak VUs (spike target)' : 'Max VUs (capacity ceiling)'}
              </label>
              <input
                type="number"
                min={form.vus + 1} max={500}
                value={form.peakVus}
                onChange={e => setForm(f => ({ ...f, peakVus: Number(e.target.value) }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          )}

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