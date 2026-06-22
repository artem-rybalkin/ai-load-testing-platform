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

  const handleSend = async () => {
    const content = input.trim();
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
        appendEntry({ role: 'assistant', kind: 'preview', config: response.config, dismissed: false });
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

  const handleRunTest = async (config: ParsedTestIntent) => {
    setError(null);
    try {
      const result = await createTest({
        type: config.type,
        targetUrl: config.targetUrl,
        description: config.description,
        options: config.options,
        thresholds: config.thresholds,
      });
      const testId: string = result?.test?.id ?? result?.id;
      if (!testId) throw new Error('Test created but no id was returned');
      watchedTestIds.current.add(testId);
      appendEntry({ role: 'assistant', kind: 'status', testId, status: 'pending' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create test');
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
    <div className="p-4 lg:p-6 flex flex-col h-[calc(100vh-2.5rem)] lg:h-screen max-w-3xl mx-auto">
      <div className="mb-4">
        <h1 className="text-[15px] font-semibold text-[#24292f]">Chat</h1>
        <p className="text-[12px] text-[#57606a] mt-1">
          Describe the test you want to run, in plain English — I&apos;ll ask follow-up questions if anything&apos;s missing.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto space-y-3 pb-3">
        {entries.map((entry, i) => {
          if (entry.kind === 'text') {
            const isUser = entry.role === 'user';
            return (
              <div key={i} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[80%] rounded-md px-3 py-2 text-[13px] ${
                    isUser ? 'bg-[#0969da] text-white' : 'bg-white border border-[#d0d7de] text-[#24292f]'
                  }`}
                >
                  {entry.content}
                </div>
              </div>
            );
          }

          if (entry.kind === 'redirect') {
            return (
              <div key={i} className="flex justify-start">
                <div className="max-w-[80%] rounded-md px-3 py-2 text-[13px] bg-white border border-[#d0d7de] text-[#24292f] space-y-2">
                  <p>{entry.reason}</p>
                  <Link
                    to="/?type=flow"
                    className="inline-block px-3 py-1.5 bg-[#0969da] hover:bg-[#0860ca] text-white rounded-md text-[12px] font-medium transition-colors"
                  >
                    Open Flow Builder
                  </Link>
                </div>
              </div>
            );
          }

          if (entry.kind === 'preview') {
            if (entry.dismissed) {
              return (
                <div key={i} className="flex justify-start">
                  <div className="max-w-[80%] rounded-md px-3 py-2 text-[13px] bg-white border border-[#d0d7de] text-[#57606a] italic">
                    Okay, keep going — let me know what to change.
                  </div>
                </div>
              );
            }
            return (
              <div key={i} className="flex justify-start">
                <div className="max-w-[90%] rounded-md border border-[#d0d7de] bg-white overflow-hidden">
                  <div className="px-3 py-2 border-b border-[#d0d7de] bg-[#f6f8fa] flex items-center gap-2">
                    <span className="px-1.5 py-0.5 bg-[#ddf4ff] text-[#0969da] rounded text-[10px] font-mono uppercase">
                      {entry.config.type}
                    </span>
                    <span className="text-[12px] font-mono text-[#24292f] truncate">{entry.config.targetUrl}</span>
                  </div>
                  <div className="p-3 text-[12px] space-y-2">
                    <p className="text-[#24292f]">{entry.config.description}</p>
                    <div>
                      <div className="text-[10px] font-semibold text-[#57606a] uppercase tracking-wide mb-1">Options</div>
                      <div className="space-y-0.5 font-mono text-[11px]">
                        {optionRows(entry.config.options).map(([k, v]) => (
                          <div key={k} className="flex justify-between gap-2">
                            <span className="text-[#57606a]">{k}</span>
                            <span className="text-[#24292f]">{v}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    {entry.config.thresholds && thresholdRows(entry.config.thresholds).length > 0 && (
                      <div>
                        <div className="text-[10px] font-semibold text-[#57606a] uppercase tracking-wide mb-1">Thresholds</div>
                        <div className="space-y-0.5 font-mono text-[11px]">
                          {thresholdRows(entry.config.thresholds).map(([k, v]) => (
                            <div key={k} className="flex justify-between gap-2">
                              <span className="text-[#57606a]">{k}</span>
                              <span className="text-[#24292f]">{v}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="px-3 py-2 border-t border-[#d0d7de] bg-[#f6f8fa] flex gap-2">
                    <button
                      type="button"
                      onClick={() => handleRunTest(entry.config)}
                      className="px-3 py-1.5 bg-[#1f883d] hover:bg-[#1a7f37] text-white rounded-md text-[12px] font-medium transition-colors"
                    >
                      Run Test
                    </button>
                    <button
                      type="button"
                      onClick={() => handleKeepChatting(entry)}
                      className="px-3 py-1.5 bg-white border border-[#d0d7de] hover:bg-[#f6f8fa] text-[#24292f] rounded-md text-[12px] font-medium transition-colors"
                    >
                      Keep chatting
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
            <div key={i} className="flex justify-start">
              <div className="max-w-[80%] rounded-md px-3 py-2 text-[13px] bg-white border border-[#d0d7de] text-[#24292f] flex items-center gap-2">
                <span
                  className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    entry.status === 'completed' ? 'bg-[#1f883d]'
                      : entry.status === 'failed' ? 'bg-[#cf222e]'
                      : entry.status === 'cancelled' ? 'bg-[#57606a]'
                      : 'bg-[#9a6700]'
                  }`}
                />
                {isPending ? (
                  <span className="font-mono text-[12px]">
                    Test <span className="text-[#57606a]">{entry.testId}</span> — {label}
                  </span>
                ) : (
                  <Link to={`/results/${entry.testId}`} className="font-mono text-[12px] text-[#0969da] hover:underline">
                    Test {entry.testId} — {label} →
                  </Link>
                )}
              </div>
            </div>
          );
        })}

        {thinking && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-md px-3 py-2 text-[13px] bg-white border border-[#d0d7de] text-[#57606a] italic">
              thinking…
            </div>
          </div>
        )}

        {error && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-md px-3 py-2 text-[13px] bg-[#fff1f0] border border-[#ffd6d3] text-[#cf222e]">
              {error}
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      <div className="flex gap-2 pt-3 border-t border-[#d0d7de]">
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          placeholder="e.g. Load test https://api.example.com with 50 VUs for 2 minutes"
          className="flex-1 px-3 py-2 border border-[#d0d7de] rounded-md text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0969da]"
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={thinking || !input.trim()}
          className="px-4 py-2 bg-[#1f883d] hover:bg-[#1a7f37] disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-md text-[13px] font-medium transition-colors"
        >
          Send
        </button>
      </div>
    </div>
  );
}
