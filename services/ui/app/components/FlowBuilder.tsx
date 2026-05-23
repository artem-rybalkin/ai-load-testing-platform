'use client';

import { useRef, useState, useEffect } from 'react';
import { FlowStep, ExtractRule, ExtractSource, RecordingSession, startRecording, stopRecording, getRecording } from '@/lib/api';

interface EnvVar { key: string; value: string }

interface Props {
  steps: FlowStep[];
  envVars: EnvVar[];
  onChange: (steps: FlowStep[]) => void;
  onEnvVarsChange: (vars: EnvVar[]) => void;
  testData: Array<Record<string, string>>;
  onTestDataChange: (rows: Array<Record<string, string>>) => void;
  csvFile: { name: string; data: string } | null;
  onCsvChange: (file: { name: string; data: string } | null) => void;
}

const SOURCE_PLACEHOLDERS: Record<ExtractSource, string> = {
  jsonpath: '$.data.token',
  header:   'X-Auth-Token',
  cookie:   'session',
  regex:    'value="([^"]+)"',
};

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;

const emptyStep = (): FlowStep => ({
  name: '',
  url: '',
  method: 'GET',
  body: '',
  headers: {},
  extract: {},
});

const parseHar = (raw: string): FlowStep[] => {
  try {
    const har = JSON.parse(raw);
    const entries: unknown[] = har?.log?.entries ?? [];
    return entries
      .filter((e: unknown) => {
        const entry = e as { request: { url: string; method: string } };
        const { url, method } = entry.request;
        // keep only XHR-like requests (skip static assets)
        return (
          /^https?:\/\//.test(url) &&
          ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method.toUpperCase()) &&
          !url.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|webp)(\?.*)?$/i)
        );
      })
      .slice(0, 20)
      .map((e: unknown, i: number) => {
        const entry = e as {
          request: {
            url: string;
            method: string;
            postData?: { text?: string };
            headers: Array<{ name: string; value: string }>;
          };
        };
        const { url, method, postData, headers } = entry.request;
        const path = (() => { try { return new URL(url).pathname; } catch { return url; } })();
        const filteredHeaders: Record<string, string> = {};
        for (const h of headers) {
          const name = h.name.toLowerCase();
          if (!['cookie', 'authorization', 'host', 'content-length', 'connection'].includes(name)) {
            filteredHeaders[h.name] = h.value;
          }
        }
        return {
          name: `Step ${i + 1}: ${method.toUpperCase()} ${path}`,
          url,
          method: method.toUpperCase() as FlowStep['method'],
          body: postData?.text ?? '',
          headers: filteredHeaders,
          extract: {},
        };
      });
  } catch {
    return [];
  }
};

export default function FlowBuilder({ steps, envVars, onChange, onEnvVarsChange, testData, onTestDataChange, csvFile, onCsvChange }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const csvRef  = useRef<HTMLInputElement>(null);

  // ── Flow Recording state ────────────────────────────────────────────────────
  const [recording, setRecording] = useState<RecordingSession | null>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [ignorePatterns, setIgnorePatterns] = useState<string[]>([]);
  const [ignoreInput, setIgnoreInput] = useState('');
  const [showIgnore, setShowIgnore] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll recorder-service every second while a session is active
  useEffect(() => {
    if (!recording || recording.status !== 'active') {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    pollRef.current = setInterval(async () => {
      try {
        const data = await getRecording(recording.id);
        setRecording(prev => prev ? { ...prev, stepCount: data.stepCount, status: data.status } : data);
      } catch { /* recorder may be temporarily unreachable — keep polling */ }
    }, 1000);
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [recording?.id, recording?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleStartRecording = async () => {
    setRecordingError(null);
    try {
      const session = await startRecording(steps[0]?.url, ignorePatterns.length ? ignorePatterns : undefined);
      setRecording(session);
      // Open the noVNC browser viewer in a new tab so the user can interact
      window.open(session.noVncUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setRecordingError(err instanceof Error ? err.message : 'Failed to start recording — is recorder-service running?');
    }
  };

  const addIgnorePattern = () => {
    const v = ignoreInput.trim();
    if (v && !ignorePatterns.includes(v)) {
      setIgnorePatterns(prev => [...prev, v]);
    }
    setIgnoreInput('');
  };

  const handleStopRecording = async () => {
    if (!recording) return;
    setRecordingError(null);
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    setRecording(prev => prev ? { ...prev, status: 'stopping' } : prev);
    try {
      const result = await stopRecording(recording.id);
      if (result.steps && result.steps.length > 0) {
        onChange(result.steps);
      }
      setRecording(null);
    } catch (err) {
      setRecordingError(err instanceof Error ? err.message : 'Failed to stop recording');
      setRecording(prev => prev ? { ...prev, status: 'active' } : prev); // revert status
    }
  };

  const update = (i: number, patch: Partial<FlowStep>) => {
    const next = steps.map((s, idx) => idx === i ? { ...s, ...patch } : s);
    onChange(next);
  };

  const addStep = () => onChange([...steps, emptyStep()]);
  const removeStep = (i: number) => onChange(steps.filter((_, idx) => idx !== i));
  const moveUp = (i: number) => {
    if (i === 0) return;
    const next = [...steps];
    [next[i - 1], next[i]] = [next[i], next[i - 1]];
    onChange(next);
  };

  const setExtractKey = (stepIdx: number, oldKey: string, newKey: string) => {
    const s = steps[stepIdx];
    const entries = Object.entries(s.extract ?? {});
    const updated: Record<string, ExtractRule> = {};
    for (const [k, v] of entries) updated[k === oldKey ? newKey : k] = v;
    update(stepIdx, { extract: updated });
  };

  const setExtractRule = (stepIdx: number, key: string, patch: Partial<ExtractRule>) => {
    const current = steps[stepIdx].extract?.[key] ?? { source: 'jsonpath' as ExtractSource, expression: '' };
    update(stepIdx, { extract: { ...steps[stepIdx].extract, [key]: { ...current, ...patch } } });
  };

  const removeExtract = (stepIdx: number, key: string) => {
    const { [key]: _, ...rest } = steps[stepIdx].extract ?? {};
    update(stepIdx, { extract: rest });
  };

  const addExtract = (stepIdx: number) => {
    update(stepIdx, { extract: { ...steps[stepIdx].extract, '': { source: 'jsonpath', expression: '' } } });
  };

  const handleHar = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const parsed = parseHar(ev.target?.result as string);
      if (parsed.length > 0) onChange(parsed);
      else alert('No XHR requests found in HAR file. Make sure to export a network recording.');
    };
    reader.readAsText(file);
    if (fileRef.current) fileRef.current.value = '';
  };

  const handleCsvUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const text = ev.target?.result as string;
      onCsvChange({ name: file.name, data: btoa(unescape(encodeURIComponent(text))) });
    };
    reader.readAsText(file);
    if (csvRef.current) csvRef.current.value = '';
  };

  const columns = testData.length > 0 ? Object.keys(testData[0]) : [];

  const addDataRow = () => {
    const empty: Record<string, string> = {};
    columns.forEach(c => { empty[c] = ''; });
    onTestDataChange([...testData, empty]);
  };

  const removeDataRow = (i: number) => onTestDataChange(testData.filter((_, idx) => idx !== i));

  const addDataColumn = () => {
    const col = `col${columns.length + 1}`;
    onTestDataChange(testData.map(row => ({ ...row, [col]: '' })));
  };

  const renameColumn = (oldCol: string, newCol: string) => {
    onTestDataChange(testData.map(row => {
      const newRow: Record<string, string> = {};
      for (const [k, v] of Object.entries(row)) newRow[k === oldCol ? newCol : k] = v;
      return newRow;
    }));
  };

  const updateCell = (rowIdx: number, col: string, val: string) => {
    onTestDataChange(testData.map((row, i) => i === rowIdx ? { ...row, [col]: val } : row));
  };

  const updateEnvVar = (i: number, field: 'key' | 'value', val: string) => {
    onEnvVarsChange(envVars.map((ev, idx) => idx === i ? { ...ev, [field]: val } : ev));
  };

  const addEnvVar = () => onEnvVarsChange([...envVars, { key: '', value: '' }]);
  const removeEnvVar = (i: number) => onEnvVarsChange(envVars.filter((_, idx) => idx !== i));

  return (
    <div className="space-y-4">
      {/* HAR import + Record button + Clear all row */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="px-3 py-1.5 text-xs font-medium border border-[#d0d7de] text-[#24292f] rounded-md hover:bg-[#f3f4f6]"
        >
          Import from HAR
        </button>

        {/* 🔴 Record button */}
        <button
          type="button"
          onClick={recording ? handleStopRecording : handleStartRecording}
          disabled={recording?.status === 'stopping'}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border transition-colors font-mono ${
            recording && recording.status !== 'stopping'
              ? 'bg-[#cf222e] border-[#cf222e] text-white hover:bg-[#a0151a]'
              : recording?.status === 'stopping'
                ? 'bg-[#eaeef2] border-[#d0d7de] text-[#57606a] cursor-not-allowed'
                : 'border-[#d0d7de] text-[#24292f] hover:bg-[#f3f4f6]'
          }`}
        >
          {recording?.status === 'stopping'
            ? '⏳ Processing…'
            : recording
              ? `⏹ Stop Recording (${recording.stepCount ?? 0})`
              : '🔴 Record'}
        </button>

        {/* Ignore list toggle — only shown when not recording */}
        {!recording && (
          <button
            type="button"
            onClick={() => setShowIgnore(v => !v)}
            className={`px-2 py-1.5 text-xs rounded-md border transition-colors ${
              showIgnore || ignorePatterns.length > 0
                ? 'border-[#0969da] text-[#0969da] bg-[#ddf4ff]'
                : 'border-[#d0d7de] text-[#57606a] hover:bg-[#f3f4f6]'
            }`}
            title="Configure URL patterns to ignore during recording"
          >
            🚫 Ignore{ignorePatterns.length > 0 ? ` (${ignorePatterns.length})` : ''}
          </button>
        )}

        {/* Clear all steps */}
        {steps.length > 0 && (
          <button
            type="button"
            onClick={() => { if (confirm('Clear all steps?')) onChange([]); }}
            className="ml-auto px-3 py-1.5 text-xs font-medium border border-[#d0d7de] text-[#cf222e] rounded-md hover:bg-[#fff0ee] hover:border-[#cf222e]"
          >
            Clear all
          </button>
        )}

        <span className={`text-xs text-[#57606a] ${steps.length > 0 ? '' : 'ml-auto'}`}>or build steps manually below</span>
        <input ref={fileRef} type="file" accept=".har,application/json" className="hidden" onChange={handleHar} />
      </div>

      {/* Ignore list panel */}
      {showIgnore && !recording && (
        <div className="p-3 border border-[#d0d7de] rounded-md bg-[#f6f8fa] text-[12px] space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-[#24292f]">🚫 Ignore list — URLs matching these patterns won&apos;t be recorded</span>
            <button onClick={() => setShowIgnore(false)} className="text-[#57606a] hover:text-[#24292f]">✕</button>
          </div>
          <p className="text-[#57606a]">
            Enter a substring (e.g. <code className="bg-[#eaeef2] px-1 rounded">analytics</code>, <code className="bg-[#eaeef2] px-1 rounded">localhost:3007</code>) or a regex wrapped in slashes (e.g. <code className="bg-[#eaeef2] px-1 rounded">/\.(png|gif)$/i</code>).
          </p>
          {/* Tag list */}
          {ignorePatterns.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {ignorePatterns.map(p => (
                <span key={p} className="inline-flex items-center gap-1 px-2 py-0.5 bg-[#eaeef2] rounded font-mono text-[11px] text-[#24292f]">
                  {p}
                  <button
                    type="button"
                    onClick={() => setIgnorePatterns(prev => prev.filter(x => x !== p))}
                    className="text-[#57606a] hover:text-[#cf222e] leading-none"
                  >×</button>
                </span>
              ))}
              <button
                type="button"
                onClick={() => setIgnorePatterns([])}
                className="text-[11px] text-[#57606a] hover:text-[#cf222e] underline ml-1"
              >clear all</button>
            </div>
          )}
          {/* Add input */}
          <div className="flex gap-2">
            <input
              type="text"
              value={ignoreInput}
              onChange={e => setIgnoreInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addIgnorePattern(); } }}
              placeholder="analytics.google.com or /hotjar|segment/i"
              className="flex-1 border border-[#d0d7de] rounded px-2 py-1 text-[12px] font-mono bg-white focus:outline-none focus:border-[#0969da]"
            />
            <button
              type="button"
              onClick={addIgnorePattern}
              disabled={!ignoreInput.trim()}
              className="px-3 py-1 text-[12px] bg-[#0969da] text-white rounded hover:bg-[#0550ae] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Add
            </button>
          </div>
        </div>
      )}

      {/* Recording active overlay */}
      {recording && recording.status === 'active' && (
        <div className="p-3 bg-[#fff8c5] border border-[#d4a72c] rounded-md text-[12px]">
          <div className="flex items-center justify-between mb-1">
            <span className="font-semibold text-[#633c01] font-mono">
              🔴 Recording — {recording.stepCount ?? 0} request{recording.stepCount !== 1 ? 's' : ''} captured
            </span>
            <a
              href={recording.noVncUrl}
              target="_blank"
              rel="noreferrer"
              className="text-[#0969da] hover:underline font-mono text-[11px]"
            >
              Open Browser ↗
            </a>
          </div>
          <p className="text-[#633c01]">
            Interact with the target page in the recording browser, then click{' '}
            <strong>⏹ Stop Recording</strong> when done.
            Steps will automatically populate below.
          </p>
        </div>
      )}

      {/* Recording error */}
      {recordingError && (
        <div className="p-2 bg-[#fff0ee] border border-[#ff818266] rounded-md text-[12px] text-[#cf222e] flex items-center justify-between">
          <span>⚠ {recordingError}</span>
          <button onClick={() => setRecordingError(null)} className="text-[#cf222e] ml-2 hover:opacity-70">✕</button>
        </div>
      )}

      {/* Steps */}
      <div className="space-y-3">
        {steps.map((step, i) => (
          <div key={i} className="border border-gray-200 rounded-xl p-4 bg-white space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-gray-400 w-6">{i + 1}</span>
              <input
                type="text"
                placeholder="Step name (e.g. Login)"
                value={step.name}
                onChange={e => update(i, { name: e.target.value })}
                className="flex-1 border border-gray-300 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              {i > 0 && (
                <button type="button" onClick={() => moveUp(i)} className="text-gray-400 hover:text-gray-600 text-xs px-1">↑</button>
              )}
              <button type="button" onClick={() => removeStep(i)} className="text-red-400 hover:text-red-600 text-xs px-1">✕</button>
            </div>

            <div className="flex gap-2">
              <select
                value={step.method}
                onChange={e => update(i, { method: e.target.value as FlowStep['method'] })}
                className="border border-gray-300 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
              >
                {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
              <input
                type="url"
                placeholder="https://api.example.com/endpoint"
                value={step.url}
                onChange={e => update(i, { url: e.target.value })}
                className="flex-1 border border-gray-300 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {(step.method === 'POST' || step.method === 'PUT' || step.method === 'PATCH') && (
              <textarea
                rows={2}
                placeholder='Request body (JSON): {"key": "value"}'
                value={step.body ?? ''}
                onChange={e => update(i, { body: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-2 py-1 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              />
            )}

            {/* Extract variables */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-gray-500 font-medium">Extract variables from response</span>
                <button type="button" onClick={() => addExtract(i)} className="text-xs text-blue-600 hover:underline">+ add</button>
              </div>
              {Object.entries(step.extract ?? {}).map(([key, rule]) => (
                <div key={key} className="flex gap-1 mb-1 items-center">
                  <input
                    type="text"
                    placeholder="varName"
                    value={key}
                    onChange={e => setExtractKey(i, key, e.target.value)}
                    className="w-24 border border-gray-200 rounded px-2 py-0.5 text-xs focus:outline-none"
                  />
                  <span className="text-gray-400 text-xs">←</span>
                  <select
                    value={rule.source}
                    onChange={e => setExtractRule(i, key, { source: e.target.value as ExtractSource })}
                    className="border border-gray-200 rounded px-1 py-0.5 text-xs bg-white focus:outline-none"
                  >
                    <option value="jsonpath">body</option>
                    <option value="header">header</option>
                    <option value="cookie">cookie</option>
                    <option value="regex">regex</option>
                  </select>
                  <input
                    type="text"
                    placeholder={SOURCE_PLACEHOLDERS[rule.source]}
                    value={rule.expression}
                    onChange={e => setExtractRule(i, key, { expression: e.target.value })}
                    className="flex-1 border border-gray-200 rounded px-2 py-0.5 text-xs focus:outline-none font-mono"
                  />
                  <button type="button" onClick={() => removeExtract(i, key)} className="text-gray-400 hover:text-red-500 text-xs">✕</button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={addStep}
        className="w-full py-2 border-2 border-dashed border-gray-300 text-gray-500 rounded-xl text-sm hover:border-blue-400 hover:text-blue-500 transition-colors"
      >
        + Add step
      </button>

      {/* Env vars */}
      <div className="border border-gray-200 rounded-xl p-4 bg-white">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-gray-700">Environment variables (credentials)</span>
          <button type="button" onClick={addEnvVar} className="text-xs text-blue-600 hover:underline">+ add</button>
        </div>
        <p className="text-xs text-gray-400 mb-3">Available in the script as <code className="bg-gray-100 px-1 rounded">__ENV.VAR_NAME</code>. Not stored in the database.</p>
        {envVars.map((ev, i) => (
          <div key={i} className="flex gap-2 mb-1">
            <input
              type="text"
              placeholder="KEY"
              value={ev.key}
              onChange={e => updateEnvVar(i, 'key', e.target.value)}
              className="w-32 border border-gray-200 rounded px-2 py-1 text-xs font-mono focus:outline-none"
            />
            <input
              type="password"
              placeholder="value"
              value={ev.value}
              onChange={e => updateEnvVar(i, 'value', e.target.value)}
              className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs font-mono focus:outline-none"
            />
            <button type="button" onClick={() => removeEnvVar(i)} className="text-gray-400 hover:text-red-500 text-xs">✕</button>
          </div>
        ))}
        {envVars.length === 0 && (
          <p className="text-xs text-gray-400">No variables. Click + add if your flow requires credentials.</p>
        )}
      </div>

      {/* Test data — inline table or CSV */}
      <div className="border border-gray-200 rounded-xl p-4 bg-white">
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-medium text-gray-700">Test data (parameterization)</span>
        </div>
        <p className="text-xs text-gray-400 mb-3">
          Distribute different data to each VU. Use <code className="bg-gray-100 px-1 rounded">row.columnName</code> in the generated script.
        </p>

        {/* Inline table */}
        {!csvFile && (
          <>
            {testData.length > 0 && (
              <div className="overflow-x-auto mb-2">
                <table className="text-xs w-full border-collapse">
                  <thead>
                    <tr>
                      {columns.map(col => (
                        <th key={col} className="border border-gray-200 px-1 py-0.5">
                          <input
                            type="text"
                            value={col}
                            onChange={e => renameColumn(col, e.target.value)}
                            className="w-full bg-transparent text-center font-semibold text-gray-600 focus:outline-none"
                          />
                        </th>
                      ))}
                      <th className="w-6" />
                    </tr>
                  </thead>
                  <tbody>
                    {testData.map((row, ri) => (
                      <tr key={ri}>
                        {columns.map(col => (
                          <td key={col} className="border border-gray-200 px-1 py-0.5">
                            <input
                              type="text"
                              value={row[col] ?? ''}
                              onChange={e => updateCell(ri, col, e.target.value)}
                              className="w-full bg-transparent focus:outline-none font-mono"
                            />
                          </td>
                        ))}
                        <td className="pl-1">
                          <button type="button" onClick={() => removeDataRow(ri)} className="text-gray-400 hover:text-red-500">✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex gap-2">
              <button type="button" onClick={() => {
                if (testData.length === 0) onTestDataChange([{ col1: '', col2: '' }]);
                else addDataRow();
              }} className="text-xs text-blue-600 hover:underline">+ add row</button>
              {testData.length > 0 && (
                <button type="button" onClick={addDataColumn} className="text-xs text-blue-600 hover:underline">+ add column</button>
              )}
            </div>
          </>
        )}

        {/* CSV upload */}
        <div className={`${testData.length > 0 ? 'mt-3 pt-3 border-t border-gray-100' : ''}`}>
          {csvFile ? (
            <div className="flex items-center gap-2 text-xs text-gray-600">
              <span>📄 {csvFile.name}</span>
              <button type="button" onClick={() => onCsvChange(null)} className="text-gray-400 hover:text-red-500">✕</button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => csvRef.current?.click()}
              className="text-xs text-blue-600 hover:underline"
            >
              {testData.length > 0 ? 'Or upload CSV instead' : 'Upload CSV file'}
            </button>
          )}
          <input ref={csvRef} type="file" accept=".csv,text/csv" className="hidden" onChange={handleCsvUpload} />
        </div>
      </div>
    </div>
  );
}
