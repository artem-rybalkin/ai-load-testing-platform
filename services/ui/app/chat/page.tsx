import { useState, useRef, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useResultsSocket } from '@/lib/useResultsSocket';
import {
  parseChatPrompt,
  createTest,
  getResult,
  ChatMessage,
  ChatParseResponse,
  ParsedTestIntent,
  ChatAttachment,
  FlowTestConfig,
  FlowStep,
} from '@/lib/api';
import type { ChatMode } from '@alt/shared';

// ── Entry types ───────────────────────────────────────────────────────────────

interface PreviewMsg {
  role: 'assistant';
  kind: 'preview';
  config: ParsedTestIntent;
  dismissed: boolean;
  started: boolean;
}

interface FlowPreviewMsg {
  role: 'assistant';
  kind: 'flowPreview';
  flow: FlowTestConfig;
  dismissed: boolean;
  started: boolean;
}

interface RedirectMsg {
  role: 'assistant';
  kind: 'redirect';
  reason: string;
}

interface StatusMsg {
  role: 'assistant';
  kind: 'status';
  testId: string;
  status: string;
}

interface TextMsg {
  role: 'user' | 'assistant';
  kind: 'text';
  content: string;
  attachments?: ChatAttachment[];
}

type ChatEntry = TextMsg | PreviewMsg | FlowPreviewMsg | RedirectMsg | StatusMsg;

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATIC_ASSET_RE = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|mp4|mp3|pdf|map|xml|avif)(\?.*)?$/i;
const STATIC_MIME_RE = /^(image|font|video|audio)\//;

// Patterns that indicate a Swagger UI viewer page or raw OpenAPI spec URL in typed text
const SWAGGER_URL_RE = /https?:\/\/[^\s]+(?:\/swagger-ui[^\s]*|\/openapi\.json[^\s]*|\/swagger\.json[^\s]*|\/v3\/api-docs[^\s]*|\/api-docs[^\s]*)/gi;

const SWAGGER_UI_PATH_RE = /\/swagger-ui(?:\/|\.html|\.htm|$)/i;
const CLIENT_SPEC_DISCOVERY_PATHS = ['/v3/api-docs', '/swagger.json', '/api-docs', '/openapi.json', '/swagger/v1/swagger.json'];

const summarizeSpecClientSide = (spec: Record<string, unknown>, sourceUrl: string): string => {
  const paths = spec.paths as Record<string, unknown> | undefined;
  if (!paths) return '[No paths found in spec]';
  const title = (spec.info as Record<string, unknown> | undefined)?.title ?? 'API';

  // Resolve base URL so the AI can build absolute step URLs.
  // Replace 'localhost' with 'host.docker.internal' so generated step URLs work inside Docker.
  let baseUrl = '';
  const servers = spec.servers as Array<{ url: string }> | undefined;
  if (servers?.[0]?.url) {
    baseUrl = servers[0].url;
  } else {
    const host = spec.host as string | undefined;
    const basePath = (spec.basePath as string | undefined) ?? '';
    const schemes = spec.schemes as string[] | undefined;
    if (host) baseUrl = `${schemes?.[0] ?? 'http'}://${host}${basePath}`;
    else { try { baseUrl = new URL(sourceUrl).origin; } catch { /* ignore */ } }
  }
  baseUrl = baseUrl.replace(/\blocalhost\b/g, 'host.docker.internal');

  const lines: string[] = [`API: ${title}`, `Base URL: ${baseUrl}`];
  for (const [path, methods] of Object.entries(paths)) {
    if (!methods || typeof methods !== 'object') continue;
    for (const [method, op] of Object.entries(methods as Record<string, unknown>)) {
      if (method === 'parameters' || method === 'summary' || method === 'description') continue;
      const operation = op as Record<string, unknown>;
      const summary = (operation.summary ?? operation.description ?? '') as string;
      const hasBody = !!(operation.requestBody as Record<string, unknown> | undefined);
      lines.push(`${method.toUpperCase()} ${baseUrl}${path}${summary ? ` — ${summary}` : ''}${hasBody ? ' (has request body)' : ''}`);
      if (lines.length >= 80) { lines.push('... (truncated)'); break; }
    }
    if (lines.length >= 80) break;
  }
  return lines.join('\n');
};

/** Fetch and summarise a Swagger/OpenAPI URL in the browser (works for localhost too). */
const fetchSwaggerClientSide = async (url: string): Promise<string | null> => {
  try {
    const parsed = new URL(url);
    if (SWAGGER_UI_PATH_RE.test(parsed.pathname)) {
      const base = `${parsed.protocol}//${parsed.host}`;
      for (const specPath of CLIENT_SPEC_DISCOVERY_PATHS) {
        try {
          const res = await fetch(base + specPath, { signal: AbortSignal.timeout(5_000) });
          if (!res.ok) continue;
          const spec = JSON.parse(await res.text()) as Record<string, unknown>;
          if (spec.paths) return summarizeSpecClientSide(spec, base + specPath);
        } catch { /* try next path */ }
      }
    }
  } catch { /* URL parse error */ }

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const text = await res.text();
    try {
      const spec = JSON.parse(text) as Record<string, unknown>;
      if (spec.paths) return summarizeSpecClientSide(spec, url);
    } catch { /* not JSON */ }
    return text.slice(0, 4000);
  } catch { return null; }
};

/** Parse a HAR file and extract non-static HTTP entries as ChatAttachment content. */
const parseHarFile = (jsonText: string): string => jsonText;

/** Read a user-uploaded file into a ChatAttachment. */
const readFileAsAttachment = (file: File): Promise<ChatAttachment> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      if (file.name.endsWith('.json')) {
        resolve({ type: 'har', content: parseHarFile(content), filename: file.name });
      } else {
        resolve({ type: 'documentation', content, filename: file.name });
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });

// Non-text assistant entries (flow proposals, single-test previews, flow-builder redirects) must
// still be serialized into the thread — otherwise a follow-up turn like "randomize the session id
// for each run" arrives with no record that a flow was ever proposed, and the AI re-asks for
// info (base URL, endpoints) that's actually sitting right there in the previous card.
const toThreadMessages = (entries: ChatEntry[]): ChatMessage[] =>
  entries
    .map((e): ChatMessage | null => {
      if (e.kind === 'text') return { role: e.role, content: e.content, attachments: e.attachments };
      if (e.kind === 'preview') return { role: 'assistant', content: `I proposed this test config: ${JSON.stringify(e.config)}` };
      if (e.kind === 'flowPreview') return { role: 'assistant', content: `I proposed this flow: ${JSON.stringify(e.flow)}` };
      if (e.kind === 'redirect') return { role: 'assistant', content: `I suggested using the Flow Builder instead: ${e.reason}` };
      return null; // 'status' entries are live test-run noise, not conversational context
    })
    .filter((m): m is ChatMessage => m !== null);

function optionRows(options: ParsedTestIntent['options']): Array<[string, string]> {
  return Object.entries(options as unknown as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]);
}

function thresholdRows(thresholds?: ParsedTestIntent['thresholds']): Array<[string, string]> {
  if (!thresholds) return [];
  return Object.entries(thresholds as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [k, String(v)]);
}

const METHOD_COLORS: Record<string, string> = {
  GET: 'text-green-fg',
  POST: 'text-accent',
  PUT: 'text-amber-fg',
  DELETE: 'text-red-fg',
  PATCH: 'text-purple-600',
};

const ATTACHMENT_TYPE_LABELS: Record<string, string> = {
  har: 'HAR recording',
  swagger_url: 'Swagger/OpenAPI',
  documentation: 'Documentation',
  codebase: 'Codebase',
};

const SUGGESTIONS: Record<ChatMode, string[]> = {
  english:  ['Spike test my API at example.com', 'Load test homepage, 10 VUs 2 min', 'Browser test with web vitals'],
  swagger:  ['Test the auth flow', 'Test all CRUD endpoints', 'Test the checkout flow'],
  context:  ['Extract steps from this recording', 'Build a flow from these docs', 'Test the scenario in this code'],
};

const MODE_META: Record<ChatMode, { label: string; hint: string; placeholder: string }> = {
  english: {
    label: 'Describe in English',
    hint: 'Describe the test you want to run — I\'ll ask for any missing details.',
    placeholder: 'Describe a test, e.g. "Spike test my API at example.com with 50 VUs for 2 min"…',
  },
  swagger: {
    label: 'Swagger / OpenAPI',
    hint: 'Paste your Swagger URL or upload the OpenAPI JSON — I\'ll extract the flow for you.',
    placeholder: 'Describe which flow to test (e.g. "test the login flow with 10 VUs for 5 min")…',
  },
  context: {
    label: 'HAR · Docs · Code',
    hint: 'Upload a HAR recording, documentation file, or code snippet — I\'ll build the test steps.',
    placeholder: 'Describe what to test or ask me to extract steps from the uploaded context…',
  },
};

// ── Chat history (localStorage) ───────────────────────────────────────────────
// Future: migrate to DB-backed sessions (chat_sessions table, GET/POST/DELETE /chat/sessions)
// for cross-device persistence and team-scoped history.

const HISTORY_KEY = 'chat_history';
const MAX_SESSIONS = 20;

interface SavedSession {
  id: string;
  title: string;
  mode: ChatMode;
  entries: ChatEntry[];
  sessionContext: ChatAttachment | null;
  savedAt: number;
}

function loadHistory(): SavedSession[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]'); }
  catch { return []; }
}

function saveToHistory(session: SavedSession) {
  try {
    const all = loadHistory().filter(s => s.id !== session.id);
    localStorage.setItem(HISTORY_KEY, JSON.stringify([session, ...all].slice(0, MAX_SESSIONS)));
  } catch { /* storage full — silently skip */ }
}

function deleteFromHistory(id: string) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(loadHistory().filter(s => s.id !== id)));
  } catch { /* ignore */ }
}

function sessionTitle(entries: ChatEntry[]): string {
  const first = entries.find(e => e.kind === 'text' && e.role === 'user') as TextMsg | undefined;
  const text = first?.content ?? 'New chat';
  return text.length > 60 ? text.slice(0, 57) + '…' : text;
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const MODE_BADGE: Record<ChatMode, string> = { english: 'EN', swagger: 'SW', context: 'CTX' };

// ── Icons ─────────────────────────────────────────────────────────────────────

const BotIcon = () => (
  <div className="w-7.5 h-7.5 rounded-[9px] bg-accent flex items-center justify-center flex-shrink-0">
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none"><path d="M11 2 4 11h4l-1 7 8-9h-5l1-7Z" fill="#fff" /></svg>
  </div>
);

// ── Flow step list ─────────────────────────────────────────────────────────────

function FlowStepList({ steps }: { steps: FlowStep[] }) {
  return (
    <div className="flex flex-col gap-1.5 mt-2.5 mb-3.5">
      {steps.map((step, i) => (
        <div key={i} className="flex items-start gap-2.5 bg-bg border border-border rounded-control px-3 py-2.5">
          <span className="font-mono text-[10px] bg-border text-tx-4 rounded px-1.5 py-0.5 flex-shrink-0 mt-0.5">{i + 1}</span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`font-mono text-[10.5px] font-bold ${METHOD_COLORS[step.method] ?? 'text-tx-3'}`}>{step.method}</span>
              <span className="font-mono text-[11px] text-tx-2 break-all">{step.url}</span>
            </div>
            <div className="text-[12px] text-tx-4 mt-0.5">{step.name}</div>
            {step.body && (
              <div className="font-mono text-[10px] text-tx-5 mt-1 truncate">body: {step.body.slice(0, 80)}{step.body.length > 80 ? '…' : ''}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function ChatPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<ChatMode>('english');
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pending attachments waiting to be sent with the next message
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  // Swagger spec fetched this session — re-sent with every subsequent turn so the AI retains context
  const [sessionContext, setSessionContext] = useState<ChatAttachment | null>(null);
  // Swagger URL input mode
  const [swaggerUrl, setSwaggerUrl] = useState('');
  const [showSwaggerInput, setShowSwaggerInput] = useState(false);

  // ── Chat history ──────────────────────────────────────────────────────────
  const [currentSessionId, setCurrentSessionId] = useState<string>(() => crypto.randomUUID());
  const [history, setHistory] = useState<SavedSession[]>(() => loadHistory());
  const [showHistory, setShowHistory] = useState(false);

  // Auto-save after every assistant reply.
  // Strip raw attachment payloads (HAR/docs content) before persisting — they can contain
  // auth headers, tokens, and PII. The user would re-upload to continue the session.
  useEffect(() => {
    if (entries.length === 0) return;
    const safeEntries = entries.map(e =>
      e.kind === 'text' && e.attachments
        ? { ...e, attachments: e.attachments.map(a => ({ ...a, content: '' })) }
        : e
    ) as ChatEntry[];
    const session: SavedSession = { id: currentSessionId, title: sessionTitle(entries), mode, entries: safeEntries, sessionContext: null, savedAt: Date.now() };
    saveToHistory(session);
    setHistory(loadHistory());
  }, [entries]); // eslint-disable-line react-hooks/exhaustive-deps

  const startNewChat = () => {
    setCurrentSessionId(crypto.randomUUID());
    setEntries([]);
    setInput('');
    setError(null);
    setPendingAttachments([]);
    setSessionContext(null);
    setShowSwaggerInput(false);
    setShowHistory(false);
  };

  const loadSession = (s: SavedSession) => {
    setCurrentSessionId(s.id);
    setMode(s.mode);
    setEntries(s.entries);
    setSessionContext(s.sessionContext);
    setInput('');
    setError(null);
    setPendingAttachments([]);
    setShowSwaggerInput(false);
    setShowHistory(false);
  };

  const removeSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    deleteFromHistory(id);
    setHistory(loadHistory());
    if (id === currentSessionId) startNewChat();
  };

  // When mode changes, reset the conversation so the new prompt starts clean
  const handleModeChange = (next: ChatMode) => {
    setMode(next);
    setEntries([]);
    setInput('');
    setError(null);
    setPendingAttachments([]);
    setSessionContext(null);
    setShowSwaggerInput(next === 'swagger');
  };

  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const watchedTestIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ behavior: 'smooth' });
  }, [entries]);

  const appendEntry = (entry: ChatEntry) => setEntries(prev => [...prev, entry]);

  // ── File upload handler ───────────────────────────────────────────────────

  const handleFiles = async (files: FileList | File[]) => {
    const fileArray = Array.from(files);
    try {
      const attachments = await Promise.all(fileArray.map(readFileAsAttachment));
      setPendingAttachments(prev => [...prev, ...attachments]);
    } catch {
      setError('Failed to read one or more files');
    }
  };

  const handleAddSwaggerUrl = () => {
    const url = swaggerUrl.trim();
    if (!url) return;
    setPendingAttachments(prev => [
      ...prev,
      { type: 'swagger_url', content: url, filename: url },
    ]);
    setSwaggerUrl('');
    setShowSwaggerInput(false);
  };

  const removeAttachment = (index: number) => {
    setPendingAttachments(prev => prev.filter((_, i) => i !== index));
  };

  // ── Send message ──────────────────────────────────────────────────────────

  const handleSend = async (text?: string) => {
    const content = (text ?? input).trim();
    if ((!content && pendingAttachments.length === 0) || thinking) return;
    setInput('');
    setError(null);

    const attachmentsToSend = [...pendingAttachments];
    setPendingAttachments([]);
    setShowSwaggerInput(false);

    // Fetch swagger_url attachments client-side so the parsed spec is:
    //   (a) included on this turn and (b) persisted as sessionContext for all subsequent turns.
    // The browser can reach localhost URLs; the server in Docker cannot.
    // This covers both the explicit URL-input path and auto-detected URLs typed in the message.
    const swaggerUrlsToFetch: string[] = attachmentsToSend
      .filter(a => a.type === 'swagger_url')
      .map(a => a.content);
    if (content) {
      SWAGGER_URL_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = SWAGGER_URL_RE.exec(content)) !== null) {
        if (!swaggerUrlsToFetch.includes(match[0])) swaggerUrlsToFetch.push(match[0]);
      }
    }
    for (const detectedUrl of swaggerUrlsToFetch) {
      // Remove the raw swagger_url stub — replace with the fetched documentation attachment
      const stubIdx = attachmentsToSend.findIndex(a => a.type === 'swagger_url' && a.content === detectedUrl);
      if (stubIdx !== -1) attachmentsToSend.splice(stubIdx, 1);
      const summary = await fetchSwaggerClientSide(detectedUrl);
      if (summary) {
        const att: ChatAttachment = { type: 'documentation', content: summary, filename: detectedUrl };
        attachmentsToSend.push(att);
        setSessionContext(att);
      }
    }

    // Always re-include the persisted spec context (from a previous turn) so the
    // AI can build flowReady steps even when the user is only providing VUs/duration.
    const allAttachments: ChatAttachment[] = sessionContext && !attachmentsToSend.some(a => a.filename === sessionContext.filename)
      ? [sessionContext, ...attachmentsToSend]
      : attachmentsToSend;

    const userEntry: TextMsg = {
      role: 'user',
      kind: 'text',
      content: content || `[${attachmentsToSend.map(a => ATTACHMENT_TYPE_LABELS[a.type]).join(', ')}]`,
      attachments: attachmentsToSend.length > 0 ? attachmentsToSend : undefined,
    };
    const nextEntries = [...entries, userEntry];
    setEntries(nextEntries);
    setThinking(true);

    try {
      const response: ChatParseResponse = allAttachments.length > 0
        ? await parseChatPrompt(toThreadMessages(nextEntries), allAttachments, mode)
        : await parseChatPrompt(toThreadMessages(nextEntries), undefined, mode);
      if (response.status === 'needsClarification') {
        appendEntry({ role: 'assistant', kind: 'text', content: response.question });
      } else if (response.status === 'redirectToFlowBuilder') {
        appendEntry({ role: 'assistant', kind: 'redirect', reason: response.reason });
      } else if (response.status === 'ready') {
        appendEntry({ role: 'assistant', kind: 'preview', config: response.config, dismissed: false, started: false });
      } else if (response.status === 'flowReady') {
        appendEntry({ role: 'assistant', kind: 'flowPreview', flow: response.flow, dismissed: false, started: false });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to parse your message');
    } finally {
      setThinking(false);
    }
  };

  // ── Run actions ───────────────────────────────────────────────────────────

  const handleKeepChatting = (entry: PreviewMsg | FlowPreviewMsg) => {
    setEntries(prev => prev.map(e => (e === entry ? { ...e, dismissed: true } : e)));
  };

  const handleRunTest = async (entry: PreviewMsg, index: number) => {
    if (entry.started) return;
    setError(null);
    setEntries(prev => prev.map((e, i) => (i === index ? { ...e, started: true } : e)));
    try {
      const result = await createTest({
        type: entry.config.type,
        targetUrl: entry.config.targetUrl,
        description: entry.config.description,
        options: entry.config.options,
        thresholds: entry.config.thresholds,
      });
      const testId: string = result?.test?.id ?? result?.id;
      if (!testId) throw new Error('Test created but no id was returned');
      watchedTestIds.current.add(testId);
      appendEntry({ role: 'assistant', kind: 'status', testId, status: 'pending' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create test');
      setEntries(prev => prev.map((e, i) => (i === index ? { ...e, started: false } : e)));
    }
  };

  const handleRunFlowTest = async (entry: FlowPreviewMsg, index: number) => {
    if (entry.started) return;
    setError(null);
    setEntries(prev => prev.map((e, i) => (i === index ? { ...e, started: true } : e)));
    try {
      const result = await createTest({
        type: 'flow',
        targetUrl: entry.flow.targetUrl,
        description: entry.flow.description,
        options: entry.flow.options,
        thresholds: entry.flow.thresholds,
        steps: entry.flow.steps,
      });
      const testId: string = result?.test?.id ?? result?.id;
      if (!testId) throw new Error('Test created but no id was returned');
      watchedTestIds.current.add(testId);
      appendEntry({ role: 'assistant', kind: 'status', testId, status: 'pending' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create flow test');
      setEntries(prev => prev.map((e, i) => (i === index ? { ...e, started: false } : e)));
    }
  };

  const handleOpenInFlowBuilder = (flow: FlowTestConfig) => {
    // Store the full flow config so page.tsx can restore steps + options + description
    try {
      sessionStorage.setItem('chatFlowConfig', JSON.stringify(flow));
    } catch {
      // sessionStorage unavailable — fall back to navigation without pre-fill
    }
    navigate('/?type=flow&fromChat=1');
  };

  // ── WebSocket ─────────────────────────────────────────────────────────────

  useResultsSocket((event) => {
    if (event.type === 'reconnected') {
      watchedTestIds.current.forEach(testId => {
        getResult(testId).then(d => {
          if (!d.result) return;
          setEntries(prev => prev.map(e =>
            e.kind === 'status' && e.testId === testId ? { ...e, status: d.result.status } : e
          ));
        }).catch(() => {});
      });
      return;
    }
    if (event.type === 'test:status' && watchedTestIds.current.has(event.testId)) {
      setEntries(prev => prev.map(e =>
        e.kind === 'status' && e.testId === event.testId ? { ...e, status: event.status } : e
      ));
    }
  });

  // ── Drag-and-drop on the whole page ──────────────────────────────────────

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files.length > 0) await handleFiles(e.dataTransfer.files);
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div onDragOver={e => e.preventDefault()} onDrop={handleDrop}>
      <div className="px-4 md:px-9 pt-7.5 flex items-end justify-between gap-4">
        <div>
          <div className="font-mono text-[11px] tracking-[0.16em] text-accent uppercase mb-1.5">— Assistant</div>
          <h1 className="font-display text-[clamp(26px,6.5vw,38px)] font-bold tracking-[-0.025em] leading-none">Chat</h1>
        </div>
        <div className="flex items-center gap-2 pb-1">
          <button
            type="button"
            onClick={() => setShowHistory(h => !h)}
            title="Chat history"
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-control text-[12.5px] font-medium border transition-colors cursor-pointer ${showHistory ? 'bg-accent text-white border-accent' : 'bg-surface border-border text-tx-3 hover:text-tx-1'}`}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="8" cy="8" r="6"/><path d="M8 5v3.5l2 1.5"/></svg>
            History{history.length > 0 && <span className="text-[10px] opacity-70">({history.length})</span>}
          </button>
          <button
            type="button"
            onClick={startNewChat}
            title="New chat"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-control text-[12.5px] font-medium bg-success text-white border border-success hover:opacity-90 transition-opacity cursor-pointer"
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 1v10M1 6h10"/></svg>
            New chat
          </button>
        </div>
      </div>

      <div className="px-4 md:px-9 py-6 flex flex-col gap-4.5">
        <div className="max-w-[760px] w-full mx-auto flex flex-col gap-4">

          {/* History panel */}
          {showHistory && (
            <div className="bg-surface border border-border rounded-xl p-3 flex flex-col gap-1.5 max-h-[320px] overflow-y-auto">
              {history.length === 0 ? (
                <p className="text-[13px] text-tx-4 text-center py-4">No saved chats yet.</p>
              ) : history.map(s => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => loadSession(s)}
                  className={`w-full text-left flex items-start gap-2.5 px-3 py-2.5 rounded-[8px] hover:bg-bg transition-colors cursor-pointer group ${s.id === currentSessionId ? 'bg-bg' : ''}`}
                >
                  <span className="flex-shrink-0 mt-0.5 font-mono text-[9.5px] bg-border text-tx-4 rounded px-1.5 py-0.5">{MODE_BADGE[s.mode]}</span>
                  <span className="flex-1 min-w-0 text-[13px] text-tx-2 truncate leading-snug">{s.title}</span>
                  <span className="flex-shrink-0 text-[11px] text-tx-5 whitespace-nowrap mt-0.5">{timeAgo(s.savedAt)}</span>
                  <button
                    type="button"
                    onClick={e => removeSession(s.id, e)}
                    className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-tx-4 hover:text-danger cursor-pointer"
                    title="Delete"
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M2 2l8 8M10 2l-8 8"/></svg>
                  </button>
                </button>
              ))}
            </div>
          )}

          {/* Mode selector */}
          <div className="flex gap-1.5 p-1 bg-bg border border-border rounded-[10px] w-fit">
            {(['english', 'swagger', 'context'] as ChatMode[]).map(m => (
              <button
                key={m}
                type="button"
                onClick={() => handleModeChange(m)}
                className={`px-3.5 py-1.75 rounded-[7px] text-[12.5px] font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                  mode === m
                    ? 'bg-surface border border-border text-tx-1 shadow-sm'
                    : 'text-tx-4 hover:text-tx-2'
                }`}
              >
                {MODE_META[m].label}
              </button>
            ))}
          </div>

          {/* Welcome message — changes with mode */}
          <div className="flex gap-3 items-start">
            <BotIcon />
            <div className="bg-surface border border-border rounded-[4px_16px_16px_16px] px-4 py-3.5 text-[14px] leading-[1.55] text-tx-2">
              {MODE_META[mode].hint}
            </div>
          </div>

          {/* Chat entries */}
          {entries.map((entry, i) => {
            if (entry.kind === 'text') {
              const isUser = entry.role === 'user';
              if (isUser) {
                return (
                  <div key={i} className="flex justify-end">
                    <div className="flex flex-col items-end gap-1.5 max-w-[82%]">
                      {entry.attachments && entry.attachments.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 justify-end">
                          {entry.attachments.map((att, j) => (
                            <AttachmentChip key={j} attachment={att} />
                          ))}
                        </div>
                      )}
                      <div className="bg-btn2 text-white rounded-[16px_4px_16px_16px] px-4 py-3.5 text-[14px] leading-[1.55]">
                        {entry.content}
                      </div>
                    </div>
                  </div>
                );
              }
              return (
                <div key={i} className="flex gap-3 items-start">
                  <BotIcon />
                  <div className="bg-surface border border-border rounded-[4px_16px_16px_16px] px-4 py-3.5 text-[14px] leading-[1.55] text-tx-2">
                    {entry.content}
                  </div>
                </div>
              );
            }

            if (entry.kind === 'redirect') {
              return (
                <div key={i} className="flex gap-3 items-start">
                  <BotIcon />
                  <div className="bg-surface border border-border rounded-[4px_16px_16px_16px] px-4.5 py-4 flex-1">
                    <p className="text-[14px] text-tx-2 mb-3.5">{entry.reason}</p>
                    <Link to="/?type=flow" className="inline-flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-white rounded-control px-4 py-2.5 text-[13px] font-bold transition-colors">
                      Open Flow Builder
                    </Link>
                  </div>
                </div>
              );
            }

            if (entry.kind === 'preview') {
              if (entry.dismissed) {
                return (
                  <div key={i} className="flex gap-3 items-start">
                    <BotIcon />
                    <div className="bg-surface border border-border rounded-[4px_16px_16px_16px] px-4 py-3.5 text-[14px] text-tx-4 italic">
                      Okay, keep going — let me know what to change.
                    </div>
                  </div>
                );
              }
              if (entry.started) {
                return (
                  <div key={i} className="flex gap-3 items-start">
                    <BotIcon />
                    <div className="bg-surface border border-border rounded-[4px_16px_16px_16px] px-4 py-3.5 text-[14px] text-tx-4 italic">
                      ✓ Test started — see status below.
                    </div>
                  </div>
                );
              }
              return (
                <div key={i} className="flex gap-3 items-start">
                  <BotIcon />
                  <div className="flex-1 bg-surface border border-border rounded-[4px_16px_16px_16px] px-4.5 py-4">
                    <p className="text-[14px] text-tx-2 mb-1">Got it — here&apos;s the test I&apos;ll run:</p>
                    <p className="text-[13px] text-tx-3 mb-3.5">{entry.config.description}</p>
                    <div className="flex flex-wrap gap-2 mb-4">
                      <span className="font-mono text-[11px] rounded-chip px-2 py-0.5 text-accent bg-orange-bg border border-orange-bd">{entry.config.type}</span>
                      <span className="font-mono text-[11px] bg-bg border border-border rounded-chip px-2 py-0.75 text-tx-3">{entry.config.targetUrl}</span>
                      {optionRows(entry.config.options).map(([k, v]) => (
                        <span key={k} className="font-mono text-[11px] bg-bg border border-border rounded-chip px-2 py-0.75 text-tx-3">{v}</span>
                      ))}
                      {thresholdRows(entry.config.thresholds).map(([k, v]) => (
                        <span key={k} className="font-mono text-[11px] bg-bg border border-border rounded-chip px-2 py-0.75 text-tx-3">{k}: {v}</span>
                      ))}
                    </div>
                    <div className="flex gap-2.5 flex-wrap">
                      <button type="button" onClick={() => handleRunTest(entry, i)}
                        className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-white rounded-control px-4 py-2.5 text-[13px] font-bold cursor-pointer transition-colors">
                        <svg width="13" height="13" viewBox="0 0 16 16" fill="#fff"><path d="M4 3l9 5-9 5z" /></svg>Run test
                      </button>
                      <button type="button" onClick={() => handleKeepChatting(entry)}
                        className="bg-surface border border-border text-tx-2 rounded-control px-4 py-2.5 text-[13px] font-semibold cursor-pointer">
                        Edit settings
                      </button>
                    </div>
                  </div>
                </div>
              );
            }

            if (entry.kind === 'flowPreview') {
              if (entry.dismissed) {
                return (
                  <div key={i} className="flex gap-3 items-start">
                    <BotIcon />
                    <div className="bg-surface border border-border rounded-[4px_16px_16px_16px] px-4 py-3.5 text-[14px] text-tx-4 italic">
                      Okay — let me know what to adjust.
                    </div>
                  </div>
                );
              }
              if (entry.started) {
                return (
                  <div key={i} className="flex gap-3 items-start">
                    <BotIcon />
                    <div className="bg-surface border border-border rounded-[4px_16px_16px_16px] px-4 py-3.5 text-[14px] text-tx-4 italic">
                      ✓ Flow test started — see status below.
                    </div>
                  </div>
                );
              }
              return (
                <div key={i} className="flex gap-3 items-start">
                  <BotIcon />
                  <div className="flex-1 bg-surface border border-border rounded-[4px_16px_16px_16px] px-4.5 py-4">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-mono text-[11px] rounded-chip px-2 py-0.5 text-accent bg-orange-bg border border-orange-bd">flow</span>
                      <p className="text-[14px] text-tx-2">Here&apos;s the flow I built:</p>
                    </div>
                    <p className="text-[13px] text-tx-3 mb-0.5">{entry.flow.description}</p>
                    <p className="font-mono text-[11px] text-tx-4 mb-1">{entry.flow.targetUrl}</p>

                    <FlowStepList steps={entry.flow.steps} />

                    <div className="flex flex-wrap gap-2 mb-4">
                      {optionRows(entry.flow.options).map(([k, v]) => (
                        <span key={k} className="font-mono text-[11px] bg-bg border border-border rounded-chip px-2 py-0.75 text-tx-3">{k}: {v}</span>
                      ))}
                      {thresholdRows(entry.flow.thresholds).map(([k, v]) => (
                        <span key={k} className="font-mono text-[11px] bg-bg border border-border rounded-chip px-2 py-0.75 text-tx-3">{k}: {v}</span>
                      ))}
                    </div>

                    <div className="flex gap-2.5 flex-wrap">
                      <button type="button" onClick={() => handleRunFlowTest(entry, i)}
                        className="flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-white rounded-control px-4 py-2.5 text-[13px] font-bold cursor-pointer transition-colors">
                        <svg width="13" height="13" viewBox="0 0 16 16" fill="#fff"><path d="M4 3l9 5-9 5z" /></svg>Run flow test
                      </button>
                      <button type="button" onClick={() => handleOpenInFlowBuilder(entry.flow)}
                        className="bg-surface border border-border text-tx-2 rounded-control px-4 py-2.5 text-[13px] font-semibold cursor-pointer">
                        Edit in Flow Builder
                      </button>
                      <button type="button" onClick={() => handleKeepChatting(entry)}
                        className="bg-surface border border-border text-tx-2 rounded-control px-4 py-2.5 text-[13px] font-semibold cursor-pointer">
                        Adjust settings
                      </button>
                    </div>
                  </div>
                </div>
              );
            }

            // status bubble
            const isPending = entry.status === 'pending' || entry.status === 'running';
            const label = entry.status === 'pending' ? 'pending…'
              : entry.status === 'running' ? 'running…'
              : entry.status;
            return (
              <div key={i} className="flex gap-3 items-start">
                <BotIcon />
                <div className="bg-surface border border-border rounded-[4px_16px_16px_16px] px-4 py-3.5 text-[14px] flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    entry.status === 'completed' ? 'bg-green-fg'
                      : entry.status === 'failed' ? 'bg-red-fg'
                      : entry.status === 'cancelled' ? 'bg-tx-4'
                      : 'bg-amber-fg'
                  }`} />
                  {isPending ? (
                    <span className="font-mono text-[12.5px]">Test <span className="text-tx-4">{entry.testId}</span> — {label}</span>
                  ) : (
                    <Link to={`/results/${entry.testId}`} className="font-mono text-[12.5px] text-accent hover:underline">
                      Test {entry.testId} — {label} →
                    </Link>
                  )}
                </div>
              </div>
            );
          })}

          {thinking && (
            <div className="flex gap-3 items-start">
              <BotIcon />
              <div className="bg-surface border border-border rounded-[4px_16px_16px_16px] px-4 py-3.5 text-[14px] text-tx-4 italic">thinking…</div>
            </div>
          )}

          {error && (
            <div className="flex gap-3 items-start">
              <BotIcon />
              <div className="bg-red-bg border border-red-fg/30 rounded-[4px_16px_16px_16px] px-4 py-3.5 text-[14px] text-red-fg">{error}</div>
            </div>
          )}

          <div ref={bottomRef} />

          {entries.length === 0 && (
            <div className="flex gap-2 flex-wrap pl-10.5">
              {SUGGESTIONS[mode].map(s => (
                <button key={s} type="button" onClick={() => handleSend(s)}
                  className="text-[12.5px] text-tx-3 bg-surface border border-border rounded-full px-3.5 py-1.75 cursor-pointer hover:border-tx-5">
                  {s}
                </button>
              ))}
            </div>
          )}

          {/* Swagger URL input */}
          {showSwaggerInput && (
            <div className="bg-surface border border-border rounded-[12px] px-3.5 py-3 flex gap-2 items-center">
              <svg width="14" height="14" viewBox="0 0 20 20" fill="none" className="flex-shrink-0 text-tx-4"><rect x="2" y="2" width="16" height="16" rx="3" stroke="currentColor" strokeWidth="1.5"/><path d="M6 7h8M6 10h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              <input
                type="url"
                value={swaggerUrl}
                onChange={e => setSwaggerUrl(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleAddSwaggerUrl(); if (e.key === 'Escape') setShowSwaggerInput(false); }}
                placeholder="https://api.example.com/openapi.json"
                autoFocus
                className="flex-1 text-[13px] bg-transparent border-none focus:outline-none placeholder:text-tx-5"
              />
              <button type="button" onClick={handleAddSwaggerUrl}
                disabled={!swaggerUrl.trim()}
                className="text-[12px] font-semibold text-accent disabled:opacity-40 cursor-pointer">
                Add
              </button>
              <button type="button" onClick={() => setShowSwaggerInput(false)}
                className="text-tx-4 hover:text-tx-2 cursor-pointer">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 3l10 10M13 3L3 13"/></svg>
              </button>
            </div>
          )}

          {/* Pending attachments */}
          {pendingAttachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pl-0">
              {pendingAttachments.map((att, i) => (
                <div key={i} className="flex items-center gap-1.5 bg-bg border border-border rounded-full px-2.5 py-1 text-[12px] text-tx-3">
                  <AttachmentIcon type={att.type} />
                  <span className="max-w-[160px] truncate">{att.filename ?? ATTACHMENT_TYPE_LABELS[att.type]}</span>
                  <button type="button" onClick={() => removeAttachment(i)}
                    className="text-tx-5 hover:text-tx-2 cursor-pointer flex-shrink-0">
                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M2 2l8 8M10 2L2 10"/></svg>
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Input bar */}
          <div className="flex items-center gap-2.5 bg-surface border border-border rounded-[14px] px-2 py-2 pl-4 mt-1">
            {/* Attachment button */}
            <div className="relative flex-shrink-0 flex items-center gap-1">
              <button
                type="button"
                title="Attach file (HAR, Swagger JSON, docs, codebase)"
                onClick={() => fileInputRef.current?.click()}
                className="w-8 h-8 rounded-[8px] flex items-center justify-center text-tx-4 hover:text-tx-2 hover:bg-bg transition-colors cursor-pointer"
              >
                <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M16.5 11l-6 6a5 5 0 01-7.07-7.07l7.07-7.07a3 3 0 014.24 4.24L8.12 13.7a1 1 0 01-1.41-1.41l6.37-6.37"/>
                </svg>
              </button>
              <button
                type="button"
                title="Add Swagger / OpenAPI URL"
                onClick={() => setShowSwaggerInput(prev => !prev)}
                className={`w-8 h-8 rounded-[8px] flex items-center justify-center transition-colors cursor-pointer ${showSwaggerInput ? 'bg-orange-bg text-accent' : 'text-tx-4 hover:text-tx-2 hover:bg-bg'}`}
              >
                <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
                  <rect x="2" y="3" width="16" height="14" rx="2.5"/>
                  <path d="M6 8h8M6 11h5"/>
                </svg>
              </button>
            </div>

            <input
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
              placeholder={MODE_META[mode].placeholder}
              className="flex-1 text-[14px] bg-transparent border-none focus:outline-none placeholder:text-tx-5"
            />
            <button
              type="button"
              onClick={() => handleSend()}
              disabled={thinking || (!input.trim() && pendingAttachments.length === 0)}
              aria-label="Send"
              className="w-9.5 h-9.5 rounded-[10px] bg-accent flex items-center justify-center flex-shrink-0 disabled:opacity-50 cursor-pointer"
            >
              <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M4 10h11M10 5l5 5-5 5" /></svg>
            </button>
          </div>

          {mode === 'english' && (
            <p className="text-[11.5px] text-tx-5 text-center -mt-1">
              Switch to <strong>Swagger</strong> or <strong>HAR · Docs · Code</strong> mode to build multi-step flows from a spec or recording.
            </p>
          )}
          {mode === 'swagger' && (
            <p className="text-[11.5px] text-tx-5 text-center -mt-1">
              Paste a Swagger URL above (including <code className="font-mono">localhost</code>) — it will be fetched automatically — or drop an <strong>openapi.json</strong> file.
            </p>
          )}
          {mode === 'context' && (
            <p className="text-[11.5px] text-tx-5 text-center -mt-1">
              Drop a <strong>.json</strong> HAR file, a documentation <strong>.md/.txt</strong>, or a code file — I&apos;ll extract the test steps.
            </p>
          )}
        </div>
      </div>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,.yaml,.yml,.txt,.md,.ts,.js,.py,.java,.go,.cs,.rb,.php"
        multiple
        className="hidden"
        onChange={e => { if (e.target.files) handleFiles(e.target.files); e.target.value = ''; }}
      />
    </div>
  );
}

// ── Small helper components ───────────────────────────────────────────────────

function AttachmentIcon({ type }: { type: string }) {
  if (type === 'har') return <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="8" cy="8" r="6"/><path d="M8 5v3l2 2"/></svg>;
  if (type === 'swagger_url') return <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M5 6h6M5 9h4"/></svg>;
  return <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 2h8a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z"/><path d="M5 6h6M5 9h4"/></svg>;
}

function AttachmentChip({ attachment }: { attachment: ChatAttachment }) {
  return (
    <div className="flex items-center gap-1.5 bg-bg/80 border border-border rounded-full px-2.5 py-1 text-[11px] text-tx-4">
      <AttachmentIcon type={attachment.type} />
      <span className="max-w-[140px] truncate">{attachment.filename ?? ATTACHMENT_TYPE_LABELS[attachment.type]}</span>
    </div>
  );
}
