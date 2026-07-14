import { useRef, useState, useEffect } from 'react';
import { FlowStep, ExtractRule, ExtractSource, RecordingSession, startRecording, stopRecording, getRecording, suggestParamColumns, RECORDER_URL } from '@/lib/api';

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
  teamId?: string;
  totalVus: number;
}

interface Journey { stepCount: number; vus: number; execName: string }

// Effective (post-inheritance) percent of the step just before index i — the
// clamp ceiling for that step's own input, since a funnel can only shrink.
const effectivePercentBefore = (steps: FlowStep[], i: number): number => {
  let prev = 100;
  for (let k = 0; k < i; k++) prev = steps[k]?.userPercent ?? prev;
  return prev;
};

// Duplicated from packages/shared/src/journeys.ts's computeJourneys() rather
// than imported: @alt/shared compiles to CommonJS with a circular require
// (aiProvider.ts imports redactPII back from index.ts) that Vite's esbuild
// dependency pre-bundler cannot resolve when treated as a runtime dependency
// (dev server: "Could not resolve './aiProvider'"; production: Rollup can't
// statically trust a named export once any dynamic re-export coexists in the
// same CJS file). Every other @alt/shared usage in this codebase is
// `import type`, erased before bundling — this small, stable, pure function is
// duplicated here rather than chasing a monorepo-wide bundler/circularity fix.
const computeJourneys = (steps: FlowStep[], totalVus: number): Journey[] => {
  const percents: number[] = [];
  let prev = 100;
  for (const s of steps) { prev = s.userPercent ?? prev; percents.push(prev); }
  const firstPercent = percents[0] ?? 100;

  const runs: Array<{ percent: number; stepCount: number }> = [];
  percents.forEach((p, i) => {
    const last = runs[runs.length - 1];
    if (last && last.percent === p) last.stepCount = i + 1;
    else runs.push({ percent: p, stepCount: i + 1 });
  });

  if (runs.length === 1) {
    return [{ stepCount: steps.length, vus: totalVus, execName: 'default' }];
  }

  const shares = runs.map((run, i) => {
    const nextPercent = runs[i + 1]?.percent ?? 0;
    return (run.percent - nextPercent) / firstPercent;
  });

  const raw = shares.map(share => share * totalVus);
  const floors = raw.map(Math.floor);
  let remainder = totalVus - floors.reduce((a, b) => a + b, 0);
  const byFracDesc = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  const vusPerRun = [...floors];
  for (let k = 0; k < byFracDesc.length && remainder > 0; k++, remainder--) {
    vusPerRun[byFracDesc[k]!.i]!++;
  }

  const journeys = runs
    .map((run, i) => ({ stepCount: run.stepCount, vus: vusPerRun[i]!, execName: `journey${i + 1}` }))
    .filter(j => j.vus > 0);

  if (journeys.length === 1) {
    return [{ stepCount: journeys[0]!.stepCount, vus: totalVus, execName: 'default' }];
  }
  return journeys;
};

const journeyLabel = (stepCount: number, steps: FlowStep[]): string => {
  if (stepCount >= steps.length) return 'full flow';
  const names = steps.slice(0, stepCount).map((s, i) => s.name || `Step ${i + 1}`);
  return stepCount === 1 ? `${names[0]} only` : names.join('→');
};

const SOURCE_PLACEHOLDERS: Record<ExtractSource, string> = {
  jsonpath: '$.data.token',
  header:   'X-Auth-Token',
  cookie:   'session',
  regex:    'value="([^"]+)"',
};

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;

type StopResult = RecordingSession & {
  geminiRateLimited?: boolean;
  suggestedIgnore?: string[];
  thinkTimes?: number[];
  duplicates?: Array<{ indices: number[]; suggestion: string }>;
};

const emptyStep = (): FlowStep => ({
  name: '',
  url: '',
  method: 'GET',
  body: '',
  headers: {},
  extract: {},
});

const STATIC_ASSET_RE = /\.(js|mjs|cjs|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|webp|avif|mp4|mp3|webm|pdf|map|xml|txt|csv)(\?.*)?$/i;
const STATIC_MIME_RE  = /^(text\/css|application\/javascript|font\/|image\/|audio\/|video\/|application\/pdf)/i;

export const parseHar = (raw: string): FlowStep[] => {
  try {
    const har = JSON.parse(raw);
    const entries: unknown[] = har?.log?.entries ?? [];
    return entries
      .filter((e: unknown) => {
        const entry = e as {
          request: { url: string; method: string };
          response?: { content?: { mimeType?: string } };
        };
        const { url, method } = entry.request;
        const mimeType = entry.response?.content?.mimeType ?? '';
        return (
          /^https?:\/\//.test(url) &&
          ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method.toUpperCase()) &&
          !STATIC_ASSET_RE.test(url) &&
          !STATIC_MIME_RE.test(mimeType)
        );
      })
      .slice(0, 50)
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

export default function FlowBuilder({ steps, envVars, onChange, onEnvVarsChange, testData, onTestDataChange, csvFile, onCsvChange, teamId, totalVus }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const csvRef  = useRef<HTMLInputElement>(null);
  const ignoreFileRef = useRef<HTMLInputElement>(null);

  // ── Flow Recording state ────────────────────────────────────────────────────
  const RECORDING_STORAGE_KEY = 'flowRecordingSession';
  // Tracks whether `recording` was restored from localStorage on mount (vs. started fresh)
  const resumedSessionRef = useRef(false);
  const [recording, setRecording] = useState<RecordingSession | null>(() => {
    try {
      const stored = localStorage.getItem(RECORDING_STORAGE_KEY);
      if (!stored) return null;
      const session = JSON.parse(stored) as RecordingSession;
      if (session.status === 'active' || session.status === 'stopping') {
        resumedSessionRef.current = true;
        return session;
      }
    } catch { /* ignore */ }
    return null;
  });
  const [recordingLaunching, setRecordingLaunching] = useState(false);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [recordingNote, setRecordingNote] = useState<string | null>(null);
  const [suggestedIgnore, setSuggestedIgnore] = useState<string[]>([]);
  const [thinkTimes, setThinkTimes] = useState<number[]>([]);
  const [duplicates, setDuplicates] = useState<Array<{ indices: number[]; suggestion: string }>>([]);
  const IGNORE_STORAGE_KEY = 'recorderIgnorePatterns';
  const [ignorePatterns, setIgnorePatterns] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem(IGNORE_STORAGE_KEY);
      return stored ? (JSON.parse(stored) as string[]) : [];
    } catch { return []; }
  });
  const [ignoreInput, setIgnoreInput] = useState('');
  const [showIgnore, setShowIgnore] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Apply a /recordings/:id/stop (or completed /recordings/:id poll) result — shared by
  // the in-app Stop button, the noVNC viewer tab's "Stop Recording & Import Steps" button,
  // and the polling fallback that detects external completion.
  const applyStopResult = (result: StopResult, captured: number) => {
    if (result.suggestedIgnore && result.suggestedIgnore.length > 0) {
      setSuggestedIgnore(result.suggestedIgnore);
    }
    if (result.thinkTimes && result.thinkTimes.length > 0) {
      setThinkTimes(result.thinkTimes);
    }
    if (result.duplicates && result.duplicates.length > 0) {
      setDuplicates(result.duplicates);
    }
    if (result.steps && result.steps.length > 0) {
      onChange(result.steps);
      if (result.geminiRateLimited) {
        setRecordingNote(
          'Gemini quota exceeded — correlation detection skipped. Extract variables were not auto-detected. ' +
          'Add them manually or retry after midnight UTC when the quota resets.'
        );
      } else if (captured > result.steps.length) {
        setRecordingNote(
          `${result.steps.length} of ${captured} captured requests imported (max 50). ` +
          `Use the 🚫 Ignore list to filter analytics/background requests before recording.`
        );
      }
    }
  };

  // Poll recorder-service every second while a session is active
  useEffect(() => {
    if (!recording || recording.status !== 'active') {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    pollRef.current = setInterval(async () => {
      try {
        const data = await getRecording(recording.id);
        if (data.status === 'completed' || data.status === 'error') {
          // Session ended externally (stopped from noVNC toolbar) — import steps + AI suggestions and clear state
          applyStopResult(data as StopResult, recordingRef.current?.stepCount ?? 0);
          setRecording(null);
        } else {
          setRecording(prev => prev ? {
            ...prev,
            stepCount: data.stepCount,
            // Don't propagate server-side 'stopping' into local state — it would stop the poll.
            // Only handleStopRecording (triggered by user) should set local status to 'stopping'.
            status: data.status === 'stopping' ? prev.status : data.status,
          } : data);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (msg.includes('404')) {
          // Session expired from cache (>10 min) — just clear the stale UI state
          setRecording(null);
        }
        // Other errors (network hiccup): keep polling silently
      }
    }, 1000);
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [recording?.id, recording?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist the active recording session to localStorage so it survives a page
  // reload or navigation away from "New Test" — FlowBuilder unmounts, but the
  // recorder-service session keeps running server-side.
  useEffect(() => {
    try {
      if (recording) localStorage.setItem(RECORDING_STORAGE_KEY, JSON.stringify(recording));
      else localStorage.removeItem(RECORDING_STORAGE_KEY);
    } catch { /* private browsing or storage full */ }
  }, [recording]); // eslint-disable-line react-hooks/exhaustive-deps

  // On mount, if a recording session was restored from localStorage, re-attach the
  // viewer callback and check its current status — it may have completed while
  // this component was unmounted.
  useEffect(() => {
    if (!resumedSessionRef.current) return;
    const rec = recordingRef.current;
    if (!rec) return;

    (window as any).__recordingDone = (result: StopResult) => {
      applyStopResult(result, recordingRef.current?.stepCount ?? 0);
      setRecording(null);
      delete (window as any).__recordingDone;
    };

    (async () => {
      try {
        const data = await getRecording(rec.id);
        if (data.status === 'completed' || data.status === 'error') {
          applyStopResult(data as StopResult, rec.stepCount ?? 0);
          setRecording(null);
        } else {
          // Treat a restored 'stopping' status as 'active' so polling resumes
          setRecording({ ...data, status: data.status === 'stopping' ? 'active' : data.status });
          setRecordingNote('Resumed a recording session that was already in progress.');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (msg.includes('404')) {
          // Session expired from cache (>10 min) — clear stale state
          setRecording(null);
        }
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // When the user switches back to this tab from the viewer, immediately check
  // for completion — the 1s interval is throttled in background tabs and
  // window.opener is null for cross-origin tabs (port 3006 → 3007).
  const recordingRef = useRef(recording);
  recordingRef.current = recording;
  useEffect(() => {
    const onVisible = async () => {
      if (document.hidden) return;
      const rec = recordingRef.current;
      if (!rec || rec.status !== 'active') return;
      try {
        const data = await getRecording(rec.id);
        if (data.status === 'completed' || data.status === 'error') {
          applyStopResult(data as StopResult, rec.stepCount ?? 0);
          setRecording(null);
        } else {
          setRecording(prev => prev ? {
            ...prev,
            stepCount: data.stepCount,
            status: data.status === 'stopping' ? prev.status : data.status,
          } : data);
        }
      } catch { /* ignore */ }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleStartRecording = async () => {
    setRecordingError(null);
    setRecordingLaunching(true);
    try {
      const session = await startRecording(steps[0]?.url, ignorePatterns.length ? ignorePatterns : undefined, teamId);
      setRecording(session);
      // Register a callback so the viewer tab can push the full /stop result back via window.opener
      (window as any).__recordingDone = (result: StopResult) => {
        applyStopResult(result, recordingRef.current?.stepCount ?? 0);
        setRecording(null);
        delete (window as any).__recordingDone;
      };
      // Open the viewer via the Vite proxy (/viewer proxied to localhost:3007).
      // Same-origin (both localhost:3006) so window.opener.__recordingDone() works.
      window.open(`/viewer/${session.id}`, '_blank');
    } catch (err) {
      setRecordingError(err instanceof Error ? err.message : 'Failed to start recording — is recorder-service running?');
    } finally {
      setRecordingLaunching(false);
    }
  };

  // Persist ignore patterns to localStorage whenever they change
  useEffect(() => {
    try { localStorage.setItem(IGNORE_STORAGE_KEY, JSON.stringify(ignorePatterns)); }
    catch { /* private browsing or storage full */ }
  }, [ignorePatterns]);

  const addIgnorePattern = () => {
    const v = ignoreInput.trim();
    if (v && !ignorePatterns.includes(v)) {
      setIgnorePatterns(prev => [...prev, v]);
    }
    setIgnoreInput('');
  };

  const handleExportIgnoreList = () => {
    const blob = new Blob([JSON.stringify(ignorePatterns, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ignore-list.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportIgnoreList = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const parsed = JSON.parse(ev.target?.result as string);
        if (!Array.isArray(parsed) || !parsed.every(p => typeof p === 'string')) {
          throw new Error('Expected a JSON array of strings');
        }
        setIgnorePatterns(prev => [...new Set([...prev, ...parsed])]);
      } catch {
        alert('Invalid ignore list file — expected a JSON array of strings');
      }
    };
    reader.readAsText(file);
    if (ignoreFileRef.current) ignoreFileRef.current.value = '';
  };

  const handleStopRecording = async () => {
    if (!recording) return;
    setRecordingError(null);
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    setRecording(prev => prev ? { ...prev, status: 'stopping' } : prev);
    try {
      const captured = recording.stepCount ?? 0;
      const result = await stopRecording(recording.id) as StopResult;
      applyStopResult(result, captured);
      setRecording(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || msg.includes('timed out'));
      if (msg.includes('404') || msg.includes('not found')) {
        // Session already ended (stopped from noVNC toolbar) — just clear state
        setRecording(null);
      } else if (isTimeout) {
        // Server is still running AI correlation — revert to active so poll can detect completion
        setRecording(prev => prev ? { ...prev, status: 'active' } : prev);
      } else {
        setRecordingError(msg || 'Failed to stop recording');
        setRecording(prev => prev ? { ...prev, status: 'active' } : prev);
      }
    }
  };

  const update = (i: number, patch: Partial<FlowStep>) => {
    const next = steps.map((s, idx) => idx === i ? { ...s, ...patch } : s);
    onChange(next);
  };

  const addStep = () => onChange([...steps, emptyStep()]);
  const removeStep = (i: number) => onChange(steps.filter((_, idx) => idx !== i));
  const moveStep = (from: number, to: number) => {
    if (to < 0 || to >= steps.length || from === to) return;
    const next = [...steps];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onChange(next);
  };

  const setHeaderKey = (stepIdx: number, oldKey: string, newKey: string) => {
    const s = steps[stepIdx];
    const entries = Object.entries(s.headers ?? {});
    const updated: Record<string, string> = {};
    for (const [k, v] of entries) updated[k === oldKey ? newKey : k] = v;
    update(stepIdx, { headers: updated });
  };

  const setHeaderValue = (stepIdx: number, key: string, value: string) => {
    update(stepIdx, { headers: { ...steps[stepIdx].headers, [key]: value } });
  };

  const removeHeader = (stepIdx: number, key: string) => {
    const { [key]: _, ...rest } = steps[stepIdx].headers ?? {};
    update(stepIdx, { headers: rest });
  };

  const addHeader = (stepIdx: number) => {
    update(stepIdx, { headers: { ...steps[stepIdx].headers, '': '' } });
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
      const raw = ev.target?.result as string;
      const parsed = parseHar(raw);
      if (parsed.length > 0) {
        onChange(parsed);
        // Show note if entries were filtered (count all HAR entries vs imported)
        try {
          const total = (JSON.parse(raw)?.log?.entries ?? []).length;
          if (total > parsed.length) {
            setRecordingNote(
              `${parsed.length} of ${total} HAR entries imported — static assets (JS, CSS, images, fonts, media) were filtered out.`
            );
          }
        } catch { /* ignore */ }
      } else {
        alert('No XHR/API requests found in HAR file. Make sure to export a network recording that includes API calls.');
      }
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
          className="px-3 py-1.5 text-xs font-medium border border-border text-tx rounded-control hover:bg-bg"
        >
          Import from HAR
        </button>

        {/* 🔴 Record button */}
        <button
          type="button"
          onClick={recording ? handleStopRecording : handleStartRecording}
          disabled={recording?.status === 'stopping' || recordingLaunching}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-control border transition-colors font-mono ${
            recording && recording.status !== 'stopping'
              ? 'bg-red-fg border-red-fg text-white hover:bg-red-badge-fg'
              : recording?.status === 'stopping'
                ? 'bg-line border-border text-tx-3 cursor-not-allowed'
                : 'border-border text-tx hover:bg-bg'
          }`}
        >
          {recordingLaunching
            ? '⏳ Launching…'
            : recording?.status === 'stopping'
              ? '⏳ Processing…'
              : recording
                ? `⏹ Stop Recording (${recording.stepCount ?? 0})`
                : '🔴 Record'}
        </button>

        {/* Escape hatch — shown when stop is taking too long or AI correlation timed out */}
        {recording?.status === 'stopping' && (
          <button
            type="button"
            onClick={() => setRecording(null)}
            className="px-2 py-1.5 text-xs rounded-control border border-border text-tx-3 hover:bg-bg transition-colors"
            title="Dismiss and return to manual editing"
          >
            ✕ Skip
          </button>
        )}

        {/* Ignore list toggle — only shown when not recording */}
        {!recording && (
          <button
            type="button"
            onClick={() => setShowIgnore(v => !v)}
            className={`px-2 py-1.5 text-xs rounded-control border transition-colors ${
              showIgnore || ignorePatterns.length > 0
                ? 'border-ink-bd text-accent bg-orange-bg'
                : 'border-border text-tx-3 hover:bg-bg'
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
            className="ml-auto px-3 py-1.5 text-xs font-medium border border-border text-red-fg rounded-control hover:bg-red-bg hover:border-red-fg"
          >
            Clear all
          </button>
        )}

        <span className={`text-xs text-tx-3 ${steps.length > 0 ? '' : 'ml-auto'}`}>or build steps manually below</span>
        <input ref={fileRef} type="file" accept=".har,application/json" className="hidden" onChange={handleHar} />
      </div>

      {/* Ignore list panel */}
      {showIgnore && !recording && (
        <div className="p-3 border border-border rounded-control bg-surface-2 text-[12px] space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-tx">🚫 Ignore list — URLs matching these patterns won&apos;t be recorded</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleExportIgnoreList}
                disabled={ignorePatterns.length === 0}
                className="text-[11px] text-accent hover:underline disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline"
                title="Download ignore list as JSON"
              >
                ↓ Export
              </button>
              <button
                type="button"
                onClick={() => ignoreFileRef.current?.click()}
                className="text-[11px] text-accent hover:underline"
                title="Import ignore list from JSON"
              >
                ↑ Import
              </button>
              <input ref={ignoreFileRef} type="file" accept=".json,application/json" className="hidden" onChange={handleImportIgnoreList} />
              <button onClick={() => setShowIgnore(false)} className="text-tx-3 hover:text-tx">✕</button>
            </div>
          </div>
          <p className="text-tx-3">
            Enter a substring (e.g. <code className="bg-line px-1 rounded">analytics</code>, <code className="bg-line px-1 rounded">localhost:3007</code>) or a regex wrapped in slashes (e.g. <code className="bg-line px-1 rounded">/\.(png|gif)$/i</code>).
          </p>
          {/* Tag list */}
          {ignorePatterns.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {ignorePatterns.map(p => (
                <span key={p} className="inline-flex items-center gap-1 px-2 py-0.5 bg-line rounded font-mono text-[11px] text-tx">
                  {p}
                  <button
                    type="button"
                    onClick={() => setIgnorePatterns(prev => prev.filter(x => x !== p))}
                    className="text-tx-3 hover:text-red-fg leading-none"
                  >×</button>
                </span>
              ))}
              <button
                type="button"
                onClick={() => setIgnorePatterns([])}
                className="text-[11px] text-tx-3 hover:text-red-fg underline ml-1"
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
              className="flex-1 border border-border rounded px-2 py-1 text-[12px] font-mono bg-surface focus:outline-none focus:border-ink-bd"
            />
            <button
              type="button"
              onClick={addIgnorePattern}
              disabled={!ignoreInput.trim()}
              className="px-3 py-1 text-[12px] bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Add
            </button>
          </div>
        </div>
      )}

      {/* Launching info panel — shown while recorder-service starts Chromium (5–10 s) */}
      {recordingLaunching && (
        <div className="p-3 bg-orange-bg border border-orange-bd rounded-control text-[12px] space-y-1.5">
          <p className="font-semibold text-accent flex items-center gap-2">
            <span className="inline-block animate-spin">⟳</span>
            Launching browser recorder…
          </p>
          <p className="text-tx-3">
            Chromium is starting inside the container — this takes <strong>5–10 seconds</strong> on first use.
            The noVNC browser tab (<code className="bg-surface-2 border border-border rounded px-1">localhost:6080</code>) will open automatically when ready.
          </p>
          <p className="text-tx-3">
            Once the browser opens, navigate to your target app using{' '}
            <code className="bg-surface-2 border border-border rounded px-1">host.docker.internal</code>{' '}
            instead of <code className="bg-surface-2 border border-border rounded px-1">localhost</code>.
          </p>
        </div>
      )}

      {/* Recording active overlay */}
      {recording && recording.status === 'active' && (
        <div className="p-3 bg-amber-bg border border-amber-fg/40 rounded-control text-[12px]">
          <div className="flex items-center justify-between mb-1">
            <span className="font-semibold text-amber-badge-fg font-mono">
              🔴 Recording — {recording.stepCount ?? 0} request{recording.stepCount !== 1 ? 's' : ''} captured
            </span>
            <a
              href={recording.noVncUrl}
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline font-mono text-[11px]"
            >
              Open Browser ↗
            </a>
          </div>
          <p className="text-amber-badge-fg">
            Interact with the target page in the recording browser, then click{' '}
            <strong>⏹ Stop Recording</strong> when done.
            Steps will automatically populate below.
          </p>
        </div>
      )}

      {/* AI correlation progress — shown while stop request is in flight */}
      {recording?.status === 'stopping' && (
        <div className="p-2 bg-orange-bg border border-orange-bd rounded-control text-[12px] text-accent flex items-center gap-2">
          <span className="animate-spin">⏳</span>
          <span>Running AI correlation detection… this may take 30–60 s. Steps will appear automatically when done.</span>
        </div>
      )}

      {/* AI-13: Step deduplication suggestions */}
      {duplicates.length > 0 && (
        <div className="p-2 bg-amber-bg border border-amber-fg/30 rounded-control text-[12px]">
          <div className="flex items-start justify-between gap-2">
            <span className="font-semibold text-amber-fg">✨ Duplicate steps detected</span>
            <button onClick={() => setDuplicates([])} className="text-amber-fg hover:opacity-70 shrink-0 text-[13px]">✕</button>
          </div>
          {duplicates.map((d, i) => (
            <p key={i} className="text-[11px] text-tx-3 font-mono mt-1">{d.suggestion}</p>
          ))}
        </div>
      )}

      {/* AI-suggested ignore patterns for next recording */}
      {suggestedIgnore.length > 0 && (
        <div className="p-2 bg-orange-bg border border-orange-bd rounded-control text-[12px] text-accent">
          <div className="flex items-start justify-between gap-2">
            <span className="font-semibold">✨ Suggested ignore patterns for next recording</span>
            <button onClick={() => setSuggestedIgnore([])} className="text-accent hover:opacity-70 shrink-0">✕</button>
          </div>
          <div className="flex flex-wrap gap-1 mt-1">
            {suggestedIgnore.map(p => (
              <span key={p} className="px-1.5 py-0.5 bg-surface border border-orange-bd rounded text-[11px] font-mono">{p}</span>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              setIgnorePatterns(prev => {
                const next = [...prev];
                for (const p of suggestedIgnore) { if (!next.includes(p)) next.push(p); }
                return next;
              });
              setSuggestedIgnore([]);
            }}
            className="mt-1.5 text-[11px] text-accent hover:underline font-medium"
          >
            + Add all to Ignore list
          </button>
        </div>
      )}

      {/* Recording truncation notice */}
      {recordingNote && (
        <div className="p-2 bg-orange-bg border border-orange-bd rounded-control text-[12px] text-accent flex items-center justify-between">
          <span>ℹ {recordingNote}</span>
          <button onClick={() => setRecordingNote(null)} className="text-accent ml-2 hover:opacity-70">✕</button>
        </div>
      )}

      {/* Recording error */}
      {recordingError && (
        <div className="p-2 bg-red-bg border border-red-fg/30 rounded-control text-[12px] text-red-fg flex items-center justify-between">
          <span>⚠ {recordingError}</span>
          <button onClick={() => setRecordingError(null)} className="text-red-fg ml-2 hover:opacity-70">✕</button>
        </div>
      )}

      {/* Too many steps to execute */}
      {steps.length > 20 && (
        <div className="p-2 bg-amber-bg border border-amber-fg/30 rounded-control text-[12px] text-amber-fg">
          ⚠ {steps.length} steps recorded — flow tests support a maximum of 20 steps. Remove {steps.length - 20} step{steps.length - 20 === 1 ? '' : 's'} before running.
        </div>
      )}

      {/* Weighted parallel journeys summary — only shown once steps actually diverge into >1 tier */}
      {steps.length > 1 && computeJourneys(steps, totalVus).length > 1 && (
        <div className="p-2 bg-accent/10 border border-accent/30 rounded-control text-[12px] text-tx-2">
          {computeJourneys(steps, totalVus)
            .map(j => `${j.vus} users: ${journeyLabel(j.stepCount, steps)}`)
            .join(' · ')}
        </div>
      )}

      {/* Steps */}
      <div className="space-y-3">
        {steps.map((step, i) => (
          <div
            key={i}
            draggable
            onDragStart={() => setDragIndex(i)}
            onDragOver={e => e.preventDefault()}
            onDrop={e => {
              e.preventDefault();
              if (dragIndex !== null && dragIndex !== i) moveStep(dragIndex, i);
              setDragIndex(null);
            }}
            onDragEnd={() => setDragIndex(null)}
            className={`border rounded-xl p-4 bg-surface space-y-3 transition-opacity ${
              dragIndex === i ? 'opacity-40 border-ink-bd' : 'border-border'
            }`}
          >
            <div className="flex items-center gap-2">
              <span
                className="cursor-grab active:cursor-grabbing text-tx-4 hover:text-tx-3 select-none px-0.5"
                title="Drag to reorder"
                aria-label={`Drag to reorder step ${i + 1}`}
              >
                ⠿
              </span>
              <span className="text-xs font-semibold text-tx-4 w-6">{i + 1}</span>
              {thinkTimes[i] > 500 && (
                <span className="text-[10px] font-mono text-tx-4" title="Observed think time before this step">⏱ {(thinkTimes[i] / 1000).toFixed(1)}s</span>
              )}
              <input
                type="text"
                placeholder="Step name (e.g. Login)"
                value={step.name}
                onChange={e => update(i, { name: e.target.value })}
                className="flex-1 border border-border rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
              />
              {steps.length > 1 && (
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={step.userPercent ?? effectivePercentBefore(steps, i)}
                  onChange={e => {
                    const ceiling = effectivePercentBefore(steps, i);
                    const raw = Number(e.target.value);
                    const clamped = Number.isFinite(raw) ? Math.min(ceiling, Math.max(0, raw)) : ceiling;
                    update(i, { userPercent: clamped });
                  }}
                  aria-label={`% of users reaching step ${i + 1}`}
                  title="% of users reaching this step"
                  className="w-16 border border-border rounded-lg px-2 py-1 text-sm text-right focus:outline-none focus:ring-1 focus:ring-accent"
                />
              )}
              {i > 0 && (
                <button type="button" onClick={() => moveStep(i, i - 1)} aria-label={`Move step ${i + 1} up`} className="text-tx-4 hover:text-tx-3 text-xs px-1">↑</button>
              )}
              {i < steps.length - 1 && (
                <button type="button" onClick={() => moveStep(i, i + 1)} aria-label={`Move step ${i + 1} down`} className="text-tx-4 hover:text-tx-3 text-xs px-1">↓</button>
              )}
              <button type="button" onClick={() => removeStep(i)} className="text-red-400 hover:text-red-600 text-xs px-1">✕</button>
            </div>

            <div className="flex gap-2">
              <select
                value={step.method}
                onChange={e => update(i, { method: e.target.value as FlowStep['method'] })}
                className="border border-border rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-accent bg-surface"
              >
                {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
              <input
                type="url"
                placeholder="https://api.example.com/endpoint"
                value={step.url}
                onChange={e => update(i, { url: e.target.value })}
                className="flex-1 border border-border rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
              />
            </div>

            {(step.method === 'POST' || step.method === 'PUT' || step.method === 'PATCH') && (
              <textarea
                rows={2}
                placeholder='Request body (JSON): {"key": "value"}'
                value={step.body ?? ''}
                onChange={e => update(i, { body: e.target.value })}
                className="w-full border border-border rounded-lg px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-accent resize-none"
              />
            )}

            {/* Request headers */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-tx-4 font-medium">Request headers</span>
                <button type="button" onClick={() => addHeader(i)} aria-label="Add request header" className="text-xs text-accent hover:underline">+ add</button>
              </div>
              {Object.entries(step.headers ?? {}).map(([key, value], hi) => (
                <div key={hi} className="flex gap-1 mb-1 items-center">
                  <input
                    type="text"
                    placeholder="Header-Name"
                    value={key}
                    onChange={e => setHeaderKey(i, key, e.target.value)}
                    className="w-40 border border-border rounded px-2 py-0.5 text-xs font-mono focus:outline-none"
                  />
                  <span className="text-tx-4 text-xs">:</span>
                  <input
                    type="text"
                    placeholder="value (supports {{varName}})"
                    value={value}
                    onChange={e => setHeaderValue(i, key, e.target.value)}
                    className="flex-1 min-w-0 border border-border rounded px-2 py-0.5 text-xs font-mono focus:outline-none"
                  />
                  <button type="button" onClick={() => removeHeader(i, key)} className="text-tx-4 hover:text-red-fg text-xs">✕</button>
                </div>
              ))}
              {Object.keys(step.headers ?? {}).length === 0 && (
                <p className="text-xs text-tx-4">No custom headers.</p>
              )}
            </div>

            {/* Extract variables */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-tx-4 font-medium">Extract variables from response</span>
                <button type="button" onClick={() => addExtract(i)} aria-label="Add extract rule" className="text-xs text-accent hover:underline">+ add</button>
              </div>
              {Object.entries(step.extract ?? {}).map(([key, rule]) => (
                <div key={key} className="flex gap-1 mb-1 items-center">
                  <input
                    type="text"
                    placeholder="varName"
                    value={key}
                    onChange={e => setExtractKey(i, key, e.target.value)}
                    className="w-24 border border-border rounded px-2 py-0.5 text-xs focus:outline-none"
                  />
                  <span className="text-tx-4 text-xs">←</span>
                  <select
                    value={rule.source}
                    onChange={e => setExtractRule(i, key, { source: e.target.value as ExtractSource })}
                    className="border border-border rounded px-1 py-0.5 text-xs bg-surface focus:outline-none"
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
                    className="flex-1 border border-border rounded px-2 py-0.5 text-xs focus:outline-none font-mono"
                  />
                  <button type="button" onClick={() => removeExtract(i, key)} className="text-tx-4 hover:text-red-fg text-xs">✕</button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={addStep}
        className="w-full py-2 border-2 border-dashed border-border text-tx-3 rounded-xl text-sm hover:border-accent hover:text-accent transition-colors"
      >
        + Add step
      </button>

      {/* Env vars */}
      <div className="border border-border rounded-xl p-4 bg-surface">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-tx-3">Environment variables (credentials)</span>
          <button type="button" onClick={addEnvVar} className="text-xs text-accent hover:underline">+ add</button>
        </div>
        <p className="text-xs text-tx-4 mb-3">Available in the script as <code className="bg-bg px-1 rounded">__ENV.VAR_NAME</code>. Not stored in the database.</p>
        {envVars.map((ev, i) => (
          <div key={i} className="flex gap-2 mb-1">
            <input
              type="text"
              placeholder="KEY"
              value={ev.key}
              onChange={e => updateEnvVar(i, 'key', e.target.value)}
              className="w-32 border border-border rounded px-2 py-1 text-xs font-mono focus:outline-none"
            />
            <input
              type="password"
              placeholder="value"
              value={ev.value}
              onChange={e => updateEnvVar(i, 'value', e.target.value)}
              className="flex-1 border border-border rounded px-2 py-1 text-xs font-mono focus:outline-none"
            />
            <button type="button" onClick={() => removeEnvVar(i)} className="text-tx-4 hover:text-red-fg text-xs">✕</button>
          </div>
        ))}
        {envVars.length === 0 && (
          <p className="text-xs text-tx-4">No variables. Click + add if your flow requires credentials.</p>
        )}
      </div>

      {/* Test data — inline table or CSV */}
      <div className="border border-border rounded-xl p-4 bg-surface">
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-medium text-tx-3">Test data (parameterization)</span>
        </div>
        <p className="text-xs text-tx-4 mb-3">
          Distribute different data to each VU. Use <code className="bg-bg px-1 rounded">row.columnName</code> in the generated script.
        </p>

        {/* Inline table */}
        {!csvFile && (
          <>
            {testData.length > 0 && (
              <div className="overflow-x-auto mb-2">
                <table className="text-xs w-full border-collapse">
                  <thead>
                    <tr>
                      {columns.map((col, ci) => (
                        <th key={ci} className="border border-border px-1 py-0.5">
                          <input
                            type="text"
                            value={col}
                            onChange={e => renameColumn(col, e.target.value)}
                            className="w-full bg-transparent text-center font-semibold text-tx-3 focus:outline-none"
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
                          <td key={col} className="border border-border px-1 py-0.5">
                            <input
                              type="text"
                              value={row[col] ?? ''}
                              onChange={e => updateCell(ri, col, e.target.value)}
                              className="w-full bg-transparent focus:outline-none font-mono"
                            />
                          </td>
                        ))}
                        <td className="pl-1">
                          <button type="button" onClick={() => removeDataRow(ri)} className="text-tx-4 hover:text-red-fg">✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex gap-2 flex-wrap">
              <button type="button" onClick={() => {
                if (testData.length === 0) onTestDataChange([{ col1: '', col2: '' }]);
                else addDataRow();
              }} className="text-xs text-accent hover:underline">+ add row</button>
              {testData.length > 0 && (
                <button type="button" onClick={addDataColumn} className="text-xs text-accent hover:underline">+ add column</button>
              )}
              {steps.length > 0 && (
                <button type="button"
                  onClick={async () => {
                    try {
                      const { columns, reasoning } = await suggestParamColumns(steps);
                      if (columns.length === 0) return;
                      const row: Record<string, string> = {};
                      for (const c of columns) row[c] = '';
                      onTestDataChange(testData.length > 0
                        ? testData.map(r => ({ ...row, ...r }))
                        : [row]);
                      alert(`Suggested: ${columns.join(', ')}\n${reasoning}`);
                    } catch (e) { alert(`Failed: ${(e as Error).message}`); }
                  }}
                  className="text-xs text-accent hover:underline font-mono">
                  ✨ Suggest columns
                </button>
              )}
            </div>
          </>
        )}

        {/* CSV upload */}
        <div className={`${testData.length > 0 ? 'mt-3 pt-3 border-t border-line' : ''}`}>
          {csvFile ? (
            <div className="flex items-center gap-2 text-xs text-tx-3">
              <span>📄 {csvFile.name}</span>
              <button type="button" onClick={() => onCsvChange(null)} className="text-tx-4 hover:text-red-fg">✕</button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => csvRef.current?.click()}
              className="text-xs text-accent hover:underline"
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
