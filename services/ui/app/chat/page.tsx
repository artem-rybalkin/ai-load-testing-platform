import { useState, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useResultsSocket } from '@/lib/useResultsSocket';
import {
  parseChatPrompt,
  createTest,
  getResult,
  ChatMessage,
  ChatParseResponse,
  ParsedTestIntent,
} from '@/lib/api';

interface PreviewMsg {
  role: 'assistant';
  kind: 'preview';
  config: ParsedTestIntent;
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
}

type ChatEntry = TextMsg | PreviewMsg | RedirectMsg | StatusMsg;

const toThreadMessages = (entries: ChatEntry[]): ChatMessage[] =>
  entries
    .filter((e): e is TextMsg => e.kind === 'text')
    .map(e => ({ role: e.role, content: e.content }));

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

const SUGGESTIONS = ['Spike test homepage', 'Soak test for 30m', 'Test the login flow'];

const BotIcon = () => (
  <div className="w-7.5 h-7.5 rounded-[9px] bg-accent flex items-center justify-center flex-shrink-0">
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none"><path d="M11 2 4 11h4l-1 7 8-9h-5l1-7Z" fill="#fff" /></svg>
  </div>
);

export default function ChatPage() {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Tracks ids of tests currently being watched, so the WS handler knows which bubbles to update.
  const watchedTestIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ behavior: 'smooth' });
  }, [entries]);

  const appendEntry = (entry: ChatEntry) => setEntries(prev => [...prev, entry]);

  const handleSend = async (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || thinking) return;
    setInput('');
    setError(null);

    const userEntry: TextMsg = { role: 'user', kind: 'text', content };
    const nextEntries = [...entries, userEntry];
    setEntries(nextEntries);
    setThinking(true);

    try {
      const response: ChatParseResponse = await parseChatPrompt(toThreadMessages(nextEntries));
      if (response.status === 'needsClarification') {
        appendEntry({ role: 'assistant', kind: 'text', content: response.question });
      } else if (response.status === 'redirectToFlowBuilder') {
        appendEntry({ role: 'assistant', kind: 'redirect', reason: response.reason });
      } else if (response.status === 'ready') {
        appendEntry({ role: 'assistant', kind: 'preview', config: response.config, dismissed: false, started: false });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to parse your message');
    } finally {
      setThinking(false);
    }
  };

  const handleKeepChatting = (entry: PreviewMsg) => {
    setEntries(prev => prev.map(e => (e === entry ? { ...e, dismissed: true } : e)));
  };

  const handleRunTest = async (entry: PreviewMsg, index: number) => {
    if (entry.started) return; // already submitted (or in flight) — ignore a duplicate click
    setError(null);
    // Mark started synchronously, before the request even goes out, so a fast double-click
    // (or clicking again after the response comes back) can't create a second test. Matched by
    // index, not object identity — this same entry gets mutated twice (started:true, then
    // possibly started:false on failure), and `entry === e` would go stale after the first
    // mutation since that produces a new object reference in state.
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
      // Creation failed — no test was actually started, so allow the user to retry.
      setEntries(prev => prev.map((e, i) => (i === index ? { ...e, started: false } : e)));
    }
  };

  useResultsSocket((event) => {
    if (event.type === 'reconnected') {
      // One-shot re-fetch per watched test — covers any terminal event missed while disconnected.
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

  return (
    <div>
      <div className="px-4 md:px-9 pt-7.5">
        <div className="font-mono text-[11px] tracking-[0.16em] text-accent uppercase mb-1.5">— Assistant</div>
        <h1 className="font-display text-[clamp(26px,6.5vw,38px)] font-bold tracking-[-0.025em] leading-none">Chat</h1>
      </div>

      <div className="px-4 md:px-9 py-6 flex flex-col gap-4.5">
        <div className="max-w-[760px] w-full mx-auto flex flex-col gap-4">
          <div className="flex gap-3 items-start">
            <BotIcon />
            <div className="bg-surface border border-border rounded-[4px_16px_16px_16px] px-4 py-3.5 text-[14px] leading-[1.55] text-tx-2">
              Hi — describe what you&apos;d like to load test and I&apos;ll configure the run for you.
            </div>
          </div>

          {entries.map((entry, i) => {
            if (entry.kind === 'text') {
              const isUser = entry.role === 'user';
              if (isUser) {
                return (
                  <div key={i} className="flex justify-end">
                    <div className="bg-btn2 text-white rounded-[16px_4px_16px_16px] px-4 py-3.5 text-[14px] leading-[1.55] max-w-[82%]">
                      {entry.content}
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
              {SUGGESTIONS.map(s => (
                <button key={s} type="button" onClick={() => handleSend(s)}
                  className="text-[12.5px] text-tx-3 bg-surface border border-border rounded-full px-3.5 py-1.75 cursor-pointer hover:border-tx-5">
                  {s}
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2.5 bg-surface border border-border rounded-[14px] px-2 py-2 pl-4 mt-1">
            <input
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
              placeholder="Describe a test, or ask a question…"
              className="flex-1 text-[14px] bg-transparent border-none focus:outline-none placeholder:text-tx-5"
            />
            <button
              type="button"
              onClick={() => handleSend()}
              disabled={thinking || !input.trim()}
              aria-label="Send"
              className="w-9.5 h-9.5 rounded-[10px] bg-accent flex items-center justify-center flex-shrink-0 disabled:opacity-50 cursor-pointer"
            >
              <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M4 10h11M10 5l5 5-5 5" /></svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
