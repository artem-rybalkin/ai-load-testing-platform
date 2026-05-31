'use client';

import { useEffect, useState } from 'react';
import {
  getWebhooks, createWebhook, deleteWebhook, Webhook,
  getLogSources, createLogSource, deleteLogSource, LogSource,
} from '@/lib/api';

const PLATFORMS = ['Grafana', 'Datadog', 'Kibana', 'Loki', 'OpenSearch', 'Custom'] as const;

const PLATFORM_PLACEHOLDER: Record<string, string> = {
  Grafana:    'https://grafana.example.com/explore?from={startedAtMs}&to={completedAtMs}&orgId=1',
  Datadog:    'https://app.datadoghq.com/logs?from_ts={startedAtMs}&to_ts={completedAtMs}',
  Kibana:     "https://kibana.example.com/app/discover#/?_g=(time:(from:'{startedAtISO}',to:'{completedAtISO}'))",
  Loki:       'https://grafana.example.com/explore?from={startedAtMs}&to={completedAtMs}&datasource=loki',
  OpenSearch: "https://opensearch.example.com/app/discover#/?_g=(time:(from:'{startedAtISO}',to:'{completedAtISO}'))",
  Custom:     'https://logs.example.com/query?start={startedAtMs}&end={completedAtMs}&url={targetUrlEncoded}',
};

const TEMPLATE_VARS = [
  ['{startedAtMs}',      'test start — epoch ms (Grafana, Datadog)'],
  ['{completedAtMs}',    'test end — epoch ms'],
  ['{startedAtISO}',     'test start — ISO 8601 (Kibana, OpenSearch)'],
  ['{completedAtISO}',   'test end — ISO 8601'],
  ['{targetUrl}',        'raw target URL'],
  ['{targetUrlEncoded}', 'URL-encoded target URL'],
  ['{testId}',           'test UUID'],
];

// ── Webhooks section ──────────────────────────────────────────────────────────

function WebhooksSection() {
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['failed', 'degraded']);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const data = await getWebhooks();
      setWebhooks(data.webhooks ?? []);
    } catch {
      setError('Could not reach results-service — check that it is running.');
    }
  };

  useEffect(() => { load(); }, []);

  const handleAdd = async () => {
    if (!url.trim()) { setError('URL is required'); return; }
    setSaving(true);
    setError('');
    try {
      await createWebhook(url.trim(), events);
      setUrl('');
      await load();
    } catch {
      setError('Failed to save webhook');
    } finally {
      setSaving(false);
    }
  };

  const toggleEvent = (e: string) =>
    setEvents(prev => prev.includes(e) ? prev.filter(x => x !== e) : [...prev, e]);

  return (
    <section>
      <h2 className="text-[13px] font-semibold text-[#24292f] mb-3">Webhooks</h2>

      <div className="bg-white border border-[#d0d7de] rounded-md overflow-hidden mb-4">
        <div className="px-4 py-2 bg-[#f6f8fa] border-b border-[#d0d7de]">
          <span className="text-[11px] font-semibold text-[#57606a] uppercase tracking-wide">Add Webhook</span>
        </div>
        <div className="p-4 space-y-3">
          <input
            type="url"
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="https://your-endpoint.example.com/webhook"
            className="w-full border border-[#d0d7de] rounded-md px-3 py-1.5 text-[13px] bg-white text-[#24292f] focus:outline-none focus:border-[#0969da] focus:ring-2 focus:ring-[#0969da]/20 placeholder-[#8c959f]"
          />
          <div className="flex items-center gap-4 text-[13px]">
            <span className="text-[#57606a]">Trigger on:</span>
            {['failed', 'degraded'].map(e => (
              <label key={e} className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={events.includes(e)}
                  onChange={() => toggleEvent(e)}
                  className="rounded border-[#d0d7de] text-[#0969da] focus:ring-[#0969da]"
                />
                <span className={`font-mono text-[12px] ${e === 'failed' ? 'text-[#cf222e]' : 'text-[#9a6700]'}`}>{e}</span>
              </label>
            ))}
          </div>
          {error && <p className="text-[#cf222e] text-[12px]">{error}</p>}
        </div>
        <div className="px-4 py-3 bg-[#f6f8fa] border-t border-[#d0d7de]">
          <button
            onClick={handleAdd}
            disabled={saving}
            className="px-4 py-1.5 bg-[#1f883d] hover:bg-[#1a7f37] text-white rounded-md text-[13px] font-medium disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : 'Add webhook'}
          </button>
        </div>
      </div>

      {webhooks.length === 0 ? (
        <div className="bg-white border border-[#d0d7de] rounded-md p-8 text-center text-[13px] text-[#57606a]">
          No webhooks configured
        </div>
      ) : (
        <div className="bg-white border border-[#d0d7de] rounded-md overflow-hidden divide-y divide-[#eaeef2]">
          {webhooks.map(w => (
            <div key={w.id} className="flex items-center justify-between px-4 py-3 hover:bg-[#f6f8fa]">
              <div className="min-w-0">
                <p className="text-[13px] font-mono text-[#24292f] truncate max-w-sm">{w.url}</p>
                <p className="text-[10px] font-mono text-[#8c959f] mt-0.5">
                  Events: {w.events.join(', ')} · Added {new Date(w.created_at).toLocaleDateString()}
                </p>
              </div>
              <button
                onClick={() => deleteWebhook(w.id).then(load)}
                className="text-[11px] text-[#cf222e] hover:underline ml-4 flex-shrink-0"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ── Log Sources section ───────────────────────────────────────────────────────

function LogSourcesSection() {
  const [sources, setSources] = useState<LogSource[]>([]);
  const [name, setName] = useState('');
  const [platform, setPlatform] = useState<string>('Grafana');
  const [urlTemplate, setUrlTemplate] = useState('');
  const [showVars, setShowVars] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const data = await getLogSources();
      setSources(data.logSources ?? []);
    } catch {
      // results-service may not be running in all envs; fail silently
    }
  };

  useEffect(() => { load(); }, []);

  const handleAdd = async () => {
    if (!name.trim() || !urlTemplate.trim()) { setError('Name and URL template are required'); return; }
    setSaving(true);
    setError('');
    try {
      await createLogSource({ name: name.trim(), platform, urlTemplate: urlTemplate.trim() });
      setName('');
      setUrlTemplate('');
      await load();
    } catch {
      setError('Failed to save log source');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <h2 className="text-[13px] font-semibold text-[#24292f] mb-1">Log Sources</h2>
      <p className="text-[12px] text-[#57606a] mb-3">
        Configure deep-link URL templates so each test result shows a &ldquo;View logs&rdquo; button
        pre-filtered to the test&rsquo;s time window.
      </p>

      <div className="bg-white border border-[#d0d7de] rounded-md overflow-hidden mb-4">
        <div className="px-4 py-2 bg-[#f6f8fa] border-b border-[#d0d7de]">
          <span className="text-[11px] font-semibold text-[#57606a] uppercase tracking-wide">Add Log Source</span>
        </div>
        <div className="p-4 space-y-3">
          <div className="flex gap-2">
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Production Grafana"
              className="flex-1 border border-[#d0d7de] rounded-md px-3 py-1.5 text-[13px] bg-white text-[#24292f] focus:outline-none focus:border-[#0969da] focus:ring-2 focus:ring-[#0969da]/20 placeholder-[#8c959f]"
            />
            <select
              value={platform}
              onChange={e => {
                setPlatform(e.target.value);
                setUrlTemplate('');
              }}
              className="border border-[#d0d7de] rounded-md px-3 py-1.5 text-[13px] bg-white text-[#24292f] focus:outline-none focus:border-[#0969da]"
            >
              {PLATFORMS.map(p => <option key={p}>{p}</option>)}
            </select>
          </div>

          <div>
            <textarea
              value={urlTemplate}
              onChange={e => setUrlTemplate(e.target.value)}
              placeholder={PLATFORM_PLACEHOLDER[platform] ?? ''}
              rows={2}
              className="w-full border border-[#d0d7de] rounded-md px-3 py-1.5 text-[12px] font-mono bg-white text-[#24292f] focus:outline-none focus:border-[#0969da] focus:ring-2 focus:ring-[#0969da]/20 placeholder-[#8c959f] resize-none"
            />
            <button
              type="button"
              onClick={() => setShowVars(v => !v)}
              className="mt-1 text-[11px] text-[#0969da] hover:underline"
            >
              {showVars ? '▲ Hide' : '▼ Available template variables'}
            </button>
            {showVars && (
              <div className="mt-2 bg-[#f6f8fa] border border-[#d0d7de] rounded-md px-3 py-2 space-y-1">
                {TEMPLATE_VARS.map(([v, desc]) => (
                  <div key={v} className="flex gap-2 text-[11px]">
                    <code className="text-[#0969da] font-mono w-44 flex-shrink-0">{v}</code>
                    <span className="text-[#57606a]">{desc}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {error && <p className="text-[#cf222e] text-[12px]">{error}</p>}
        </div>
        <div className="px-4 py-3 bg-[#f6f8fa] border-t border-[#d0d7de]">
          <button
            onClick={handleAdd}
            disabled={saving}
            className="px-4 py-1.5 bg-[#1f883d] hover:bg-[#1a7f37] text-white rounded-md text-[13px] font-medium disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : 'Add log source'}
          </button>
        </div>
      </div>

      {sources.length === 0 ? (
        <div className="bg-white border border-[#d0d7de] rounded-md p-8 text-center text-[13px] text-[#57606a]">
          No log sources configured
        </div>
      ) : (
        <div className="bg-white border border-[#d0d7de] rounded-md overflow-hidden divide-y divide-[#eaeef2]">
          {sources.map(s => (
            <div key={s.id} className="flex items-start justify-between px-4 py-3 hover:bg-[#f6f8fa]">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-[13px] font-medium text-[#24292f]">{s.name}</p>
                  {s.platform && (
                    <span className="text-[10px] font-mono bg-[#ddf4ff] text-[#0969da] px-1.5 py-0.5 rounded">{s.platform}</span>
                  )}
                </div>
                <p className="text-[11px] font-mono text-[#8c959f] mt-0.5 truncate max-w-sm">{s.url_template}</p>
              </div>
              <button
                onClick={() => deleteLogSource(s.id).then(load)}
                className="text-[11px] text-[#cf222e] hover:underline ml-4 flex-shrink-0"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function WebhooksPage() {
  return (
    <div className="p-4 lg:p-6 max-w-2xl space-y-8">
      <h1 className="text-[15px] font-semibold text-[#24292f]">Integrations</h1>
      <WebhooksSection />
      <LogSourcesSection />
    </div>
  );
}
