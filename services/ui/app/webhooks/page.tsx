'use client';

import { useEffect, useState } from 'react';
import {
  getWebhooks, createWebhook, deleteWebhook, Webhook,
  getLogSources, createLogSource, updateLogSource, deleteLogSource, LogSource,
  predictWebhookNoise,
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
  ['{startedAtMs}',      'test start — epoch milliseconds (Grafana Explore, Datadog)'],
  ['{completedAtMs}',    'test end — epoch milliseconds'],
  ['{startedAtS}',       'test start — epoch seconds (Prometheus query_range API)'],
  ['{completedAtS}',     'test end — epoch seconds'],
  ['{startedAtISO}',     'test start — ISO 8601 (Kibana, OpenSearch, Loki API)'],
  ['{completedAtISO}',   'test end — ISO 8601'],
  ['{targetUrl}',        'raw target URL'],
  ['{targetUrlEncoded}', 'URL-encoded target URL'],
  ['{testId}',           'test UUID'],
];

// ── Webhooks section ──────────────────────────────────────────────────────────

const WEBHOOK_FORMATS = [
  { value: 'generic',   label: 'Generic JSON',  hint: 'Standard JSON payload — works with any HTTP endpoint' },
  { value: 'slack',     label: 'Slack',          hint: 'Slack Incoming Webhooks — shows coloured attachment' },
  { value: 'pagerduty', label: 'PagerDuty',      hint: 'PagerDuty Events API v2 — triggers/acknowledges incidents' },
  { value: 'opsgenie',  label: 'OpsGenie',       hint: 'OpsGenie Alert API — creates alerts with priority' },
] as const;

function WebhooksSection() {
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['failed', 'degraded']);
  const [format, setFormat] = useState<string>('generic');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [noiseWarning, setNoiseWarning] = useState<{ level: string; message: string } | null>(null);
  const [checkingNoise, setCheckingNoise] = useState(false);

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
      await createWebhook(url.trim(), events, format);
      setUrl('');
      setFormat('generic');
      await load();
    } catch {
      setError('Failed to save webhook');
    } finally {
      setSaving(false);
    }
  };

  const toggleEvent = async (ev: string) => {
    const next = events.includes(ev) ? events.filter(x => x !== ev) : [...events, ev];
    setEvents(next);
    if (next.length > 0) {
      setCheckingNoise(true);
      try { const r = await predictWebhookNoise(next); setNoiseWarning(r.warning ? r : null); }
      catch { setNoiseWarning(null); }
      finally { setCheckingNoise(false); }
    } else { setNoiseWarning(null); }
  };

  return (
    <section>
      <h2 className="font-display text-[17px] font-semibold mb-3.5">Webhooks</h2>

      <div className="bg-surface border border-border rounded-control overflow-hidden mb-4">
        <div className="px-4 py-2 bg-surface-2 border-b border-border">
          <span className="text-[11px] font-semibold text-tx-3 uppercase tracking-wide">Add Webhook</span>
        </div>
        <div className="p-4 space-y-3">
          <input
            type="url"
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="https://your-endpoint.example.com/webhook"
            className="w-full border border-border rounded-control px-3 py-1.5 text-[13px] bg-surface text-tx focus:outline-none focus:border-ink-bd placeholder:text-tx-5"
          />
          <div className="flex items-center gap-4 text-[13px]">
            <span className="text-tx-3">Trigger on:</span>
            {['failed', 'degraded'].map(e => (
              <label key={e} className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={events.includes(e)}
                  onChange={() => toggleEvent(e)}
                  className="rounded border-border text-accent focus:ring-accent"
                />
                <span className={`font-mono text-[12px] ${e === 'failed' ? 'text-red-fg' : 'text-amber-fg'}`}>{e}</span>
              </label>
            ))}
          </div>
          {/* Format selector */}
          <div>
            <span className="text-tx-3 text-[13px] mr-2">Format:</span>
            <div className="flex flex-wrap gap-2 mt-1">
              {WEBHOOK_FORMATS.map(f => (
                <label key={f.value} className="flex items-center gap-1.5 cursor-pointer" title={f.hint}>
                  <input
                    type="radio"
                    name="webhook-format"
                    value={f.value}
                    checked={format === f.value}
                    onChange={() => setFormat(f.value)}
                    className="text-accent"
                  />
                  <span className="text-[13px] font-mono">{f.label}</span>
                </label>
              ))}
            </div>
            {format !== 'generic' && (
              <p className="text-[11px] text-tx-3 mt-1">
                {WEBHOOK_FORMATS.find(f => f.value === format)?.hint}
              </p>
            )}
          </div>

          {checkingNoise && <p className="text-[11px] text-tx-3 font-mono">✨ Checking noise level…</p>}
          {noiseWarning && (
            <p className={`text-[12px] font-mono ${noiseWarning.level === 'noisy' ? 'text-amber-fg' : 'text-tx-3'}`}>
              {noiseWarning.level === 'noisy' ? '⚠ ' : 'ℹ '}{noiseWarning.message}
            </p>
          )}
          {error && <p className="text-red-fg text-[12px]">{error}</p>}
        </div>
        <div className="px-4 py-3 bg-surface-2 border-t border-border">
          <button
            onClick={handleAdd}
            disabled={saving}
            className="px-4 py-1.5 bg-accent hover:bg-accent-hover text-white rounded-control text-[13px] font-medium disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : 'Add webhook'}
          </button>
        </div>
      </div>

      {webhooks.length === 0 ? (
        <div className="bg-surface border border-border rounded-control p-8 text-center text-[13px] text-tx-3">
          No webhooks configured
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-control overflow-hidden divide-y divide-line">
          {webhooks.map(w => (
            <div key={w.id} className="flex items-center justify-between px-4 py-3 hover:bg-surface-2">
              <div className="min-w-0">
                <p className="text-[13px] font-mono text-tx truncate max-w-sm">{w.url}</p>
                <p className="text-[10px] font-mono text-tx-4 mt-0.5">
                  Events: {w.events.join(', ')} · Added {new Date(w.created_at).toLocaleDateString()}
                </p>
              </div>
              <button
                onClick={() => deleteWebhook(w.id).then(load)}
                className="text-[11px] text-red-fg hover:underline ml-4 flex-shrink-0"
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [platform, setPlatform] = useState<string>('Grafana');
  const [urlTemplate, setUrlTemplate] = useState('');
  const [metricsEndpointTemplate, setMetricsEndpointTemplate] = useState('');
  const [authHeader, setAuthHeader] = useState('');
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

  const resetForm = () => {
    setEditingId(null);
    setName('');
    setPlatform('Grafana');
    setUrlTemplate('');
    setMetricsEndpointTemplate('');
    setAuthHeader('');
    setError('');
  };

  const startEdit = (source: LogSource) => {
    setEditingId(source.id);
    setName(source.name);
    setPlatform(source.platform ?? 'Custom');
    setUrlTemplate(source.url_template);
    setMetricsEndpointTemplate(source.metrics_endpoint_template ?? '');
    setAuthHeader(source.auth_header ?? '');
    setError('');
  };

  const handleSubmit = async () => {
    if (!name.trim() || !urlTemplate.trim()) { setError('Name and URL template are required'); return; }
    setSaving(true);
    setError('');
    try {
      if (editingId) {
        await updateLogSource(editingId, {
          name: name.trim(), platform, urlTemplate: urlTemplate.trim(),
          metricsEndpointTemplate: metricsEndpointTemplate.trim() || null,
          authHeader: authHeader.trim() || null,
        });
      } else {
        await createLogSource({
          name: name.trim(), platform, urlTemplate: urlTemplate.trim(),
          ...(metricsEndpointTemplate.trim() ? { metricsEndpointTemplate: metricsEndpointTemplate.trim() } : {}),
          ...(authHeader.trim() ? { authHeader: authHeader.trim() } : {}),
        });
      }
      resetForm();
      await load();
    } catch {
      setError(editingId ? 'Failed to update log source' : 'Failed to save log source');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <h2 className="font-display text-[17px] font-semibold mb-1.5">Log Sources</h2>
      <p className="text-[12.5px] text-tx-3 mb-3.5">
        Configure deep-link URL templates so each test result shows a &ldquo;View logs&rdquo; button
        pre-filtered to the test&rsquo;s time window.
      </p>

      <div className="bg-surface border border-border rounded-control overflow-hidden mb-4">
        <div className="px-4 py-2 bg-surface-2 border-b border-border">
          <span className="text-[11px] font-semibold text-tx-3 uppercase tracking-wide">
            {editingId ? 'Edit Log Source' : 'Add Log Source'}
          </span>
        </div>
        <div className="p-4 space-y-3">
          <div className="flex gap-2">
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Production Grafana"
              className="flex-1 border border-border rounded-control px-3 py-1.5 text-[13px] bg-surface text-tx focus:outline-none focus:border-ink-bd placeholder:text-tx-5"
            />
            <select
              value={platform}
              onChange={e => {
                setPlatform(e.target.value);
                setUrlTemplate('');
              }}
              className="border border-border rounded-control px-3 py-1.5 text-[13px] bg-surface text-tx focus:outline-none focus:border-ink-bd"
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
              className="w-full border border-border rounded-control px-3 py-1.5 text-[12px] font-mono bg-surface text-tx focus:outline-none focus:border-ink-bd placeholder:text-tx-5 resize-none"
            />
            <button
              type="button"
              onClick={() => setShowVars(v => !v)}
              className="mt-1 text-[11px] text-accent hover:underline"
            >
              {showVars ? '▲ Hide' : '▼ Available template variables'}
            </button>
            {showVars && (
              <div className="mt-2 bg-surface-2 border border-border rounded-control px-3 py-2 space-y-1">
                {TEMPLATE_VARS.map(([v, desc]) => (
                  <div key={v} className="flex gap-2 text-[11px]">
                    <code className="text-accent font-mono w-44 flex-shrink-0">{v}</code>
                    <span className="text-tx-3">{desc}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* AI Analysis: optional metrics API endpoint */}
          <div className="pt-2 border-t border-line">
            <label className="block text-[11px] font-semibold text-tx-3 uppercase tracking-wide mb-1.5">
              Metrics API endpoint <span className="text-tx-4 normal-case font-normal tracking-normal">(optional — fetched during AI analysis)</span>
            </label>
            <textarea
              rows={2}
              value={metricsEndpointTemplate}
              onChange={e => setMetricsEndpointTemplate(e.target.value)}
              placeholder={`https://grafana.example.com/api/datasources/proxy/1/api/v1/query_range?query=http_requests_total&start={startedAtMs}&end={completedAtMs}`}
              className="w-full border border-border rounded-control px-3 py-1.5 text-[12px] font-mono bg-surface text-tx focus:outline-none focus:border-ink-bd placeholder:text-tx-5 resize-none"
            />
            <p className="text-[11px] text-tx-3 mt-0.5">
              Returns JSON data included in AI Insights and Diagnose prompts. Supports the same template variables as the dashboard URL above.
            </p>
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-tx-3 uppercase tracking-wide mb-1.5">
              Auth header <span className="text-tx-4 normal-case font-normal tracking-normal">(optional — sent as Authorization header)</span>
            </label>
            <input
              type="password"
              value={authHeader}
              onChange={e => setAuthHeader(e.target.value)}
              placeholder="Bearer eyJhbGci…  or  Api-Key abc123"
              className="w-full border border-border rounded-control px-3 py-1.5 text-[12px] font-mono bg-surface text-tx focus:outline-none focus:border-ink-bd placeholder:text-tx-5"
            />
          </div>

          {error && <p className="text-red-fg text-[12px]">{error}</p>}
        </div>
        <div className="px-4 py-3 bg-surface-2 border-t border-border flex items-center gap-2">
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="px-4 py-1.5 bg-accent hover:bg-accent-hover text-white rounded-control text-[13px] font-medium disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add log source'}
          </button>
          {editingId && (
            <button
              onClick={resetForm}
              disabled={saving}
              className="px-4 py-1.5 border border-border hover:bg-hover text-tx rounded-control text-[13px] font-medium disabled:opacity-50 transition-colors"
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {sources.length === 0 ? (
        <div className="bg-surface border border-border rounded-control p-8 text-center text-[13px] text-tx-3">
          No log sources configured
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-control overflow-hidden divide-y divide-line">
          {sources.map(s => (
            <div key={s.id} className="flex items-start justify-between px-4 py-3 hover:bg-surface-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-[13px] font-medium text-tx">{s.name}</p>
                  {s.platform && (
                    <span className="text-[10px] font-mono bg-orange-bg text-accent px-1.5 py-0.5 rounded-chip">{s.platform}</span>
                  )}
                </div>
                <p className="text-[11px] font-mono text-tx-4 mt-0.5 truncate max-w-sm">{s.url_template}</p>
              </div>
              <div className="flex items-center gap-3 ml-4 flex-shrink-0">
                <button
                  onClick={() => startEdit(s)}
                  className="text-[11px] text-accent hover:underline"
                >
                  Edit
                </button>
                <button
                  onClick={() => deleteLogSource(s.id).then(load)}
                  className="text-[11px] text-red-fg hover:underline"
                >
                  Remove
                </button>
              </div>
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
    <div>
      <div className="px-4 md:px-9 pt-7.5">
        <div className="font-mono text-[11px] tracking-[0.16em] text-accent uppercase mb-1.5">— Integrations</div>
        <h1 className="font-display text-[clamp(26px,6.5vw,38px)] font-bold tracking-[-0.025em] leading-none">Webhooks</h1>
      </div>
      <div className="px-4 md:px-9 py-6 space-y-8">
        <WebhooksSection />
        <LogSourcesSection />
      </div>
    </div>
  );
}
