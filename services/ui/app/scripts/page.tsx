import { useState } from 'react';
import { useLoaderData, useNavigate } from 'react-router-dom';
import { getMe, getScripts, getScript, getScriptVersions, restoreScriptVersion, SavedScript, SavedScriptVersion } from '@/lib/api';
import { storageKey } from '@/lib/WorkspaceContext';

interface ScriptsLoaderData {
  scripts: SavedScript[];
  loadError: string | null;
}

// getMe() (not the AuthContext/WorkspaceContext) so this loader has no React
// context dependency — loaders run outside the component tree. The active
// workspace is read straight from localStorage, the same place WorkspaceContext
// persists it, since loaders can't subscribe to that context.
export async function loader(): Promise<ScriptsLoaderData> {
  const user = await getMe();
  const activeWorkspaceId = user.currentTeamId ? localStorage.getItem(storageKey(user.currentTeamId)) : null;
  try {
    const { scripts } = await getScripts(activeWorkspaceId);
    return { scripts, loadError: null };
  } catch {
    return { scripts: [], loadError: 'Could not reach results-service — check that it is running.' };
  }
}

// Flow scripts have no human-friendly identifier — target_url is an opaque
// `flow:<stepsHash>` cache key, not a real URL.
const scriptLabel = (s: SavedScript): string =>
  s.targetUrl.startsWith('flow:') ? `Flow script #${s.targetUrl.slice(5, 13)}` : s.targetUrl;

const fmtDate = (iso: string): string => new Date(iso).toLocaleString();

export default function ScriptsPage() {
  const navigate = useNavigate();
  const data = useLoaderData() as ScriptsLoaderData;
  const [scripts, setScripts] = useState<SavedScript[]>(data.scripts);
  const [error, setError] = useState(data.loadError ?? '');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [scriptText, setScriptText] = useState<Record<string, string>>({});
  const [historyOpen, setHistoryOpen] = useState<string | null>(null);
  const [versions, setVersions] = useState<Record<string, SavedScriptVersion[]>>({});
  const [restoring, setRestoring] = useState<string | null>(null);

  const togglePreview = async (s: SavedScript) => {
    if (expanded === s.id) { setExpanded(null); return; }
    setExpanded(s.id);
    if (scriptText[s.id] === undefined) {
      const { script } = await getScript(s.id);
      setScriptText(prev => ({ ...prev, [s.id]: script.script ?? '' }));
    }
  };

  const toggleHistory = async (id: string) => {
    if (historyOpen === id) { setHistoryOpen(null); return; }
    setHistoryOpen(id);
    if (!versions[id]) {
      const { versions: v } = await getScriptVersions(id);
      setVersions(prev => ({ ...prev, [id]: v }));
    }
  };

  const handleRestore = async (scriptId: string, versionId: string) => {
    setRestoring(versionId);
    setError('');
    try {
      await restoreScriptVersion(scriptId, versionId);
      // Drop the stale cached script + history, then immediately re-fetch
      // whichever of the two is currently expanded — expanded/historyOpen
      // stay pointed at this scriptId across the restore (the user can't
      // click Restore without the history panel already being open), so
      // waiting for "next expand" would leave the panel stuck on "Loading…".
      setScriptText(prev => { const next = { ...prev }; delete next[scriptId]; return next; });
      setVersions(prev => { const next = { ...prev }; delete next[scriptId]; return next; });
      const { scripts: fresh } = await getScripts();
      setScripts(fresh);
      if (expanded === scriptId) {
        const { script } = await getScript(scriptId);
        setScriptText(prev => ({ ...prev, [scriptId]: script.script ?? '' }));
      }
      if (historyOpen === scriptId) {
        const { versions: v } = await getScriptVersions(scriptId);
        setVersions(prev => ({ ...prev, [scriptId]: v }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restore version');
    } finally {
      setRestoring(null);
    }
  };

  const handleEditViaChat = (scriptId: string) => {
    try { sessionStorage.setItem('chatEditScriptId', scriptId); } catch { /* sessionStorage unavailable — chat falls back to its own picker */ }
    navigate('/chat');
  };

  return (
    <div>
      <div className="px-4 md:px-9 pt-7.5">
        <div className="font-mono text-[11px] tracking-[0.16em] text-accent uppercase mb-1.5">— Generated & cached</div>
        <h1 className="font-display text-[clamp(26px,6.5vw,38px)] font-bold tracking-[-0.025em] leading-none">Saved Scripts</h1>
      </div>

      <div className="px-4 md:px-9 py-6">
        <p className="text-[13px] text-tx-3 mb-5">
          Scripts generated for your tests — reused automatically for a matching URL/type. Edit one via Chat to refine it, or restore an earlier version.
        </p>

        {error && <div className="mb-4 p-3 bg-red-bg border border-red-bd rounded-control text-[13px] text-red-fg">{error}</div>}

        {scripts.length === 0 ? (
          <div className="text-[13px] text-tx-4 py-8 text-center border border-dashed border-border rounded-tile">
            No saved scripts yet. Run a test and its generated script will show up here.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {scripts.map(s => (
              <div key={s.id} className="bg-surface border border-border rounded-tile p-4">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="min-w-0">
                    <div className="font-mono text-[13px] truncate">{scriptLabel(s)}</div>
                    <div className="text-[11.5px] text-tx-4 mt-0.5">
                      <span className="font-mono border border-orange-bd rounded-chip px-1.5 py-0.5 text-accent bg-orange-bg mr-2">{s.testType}</span>
                      used {s.usedCount}× · updated {fmtDate(s.updatedAt)}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <button type="button" onClick={() => togglePreview(s)} className="text-[12px] text-tx-3 hover:text-tx">
                      {expanded === s.id ? 'Hide script' : 'View script'}
                    </button>
                    <button type="button" onClick={() => toggleHistory(s.id)} className="text-[12px] text-tx-3 hover:text-tx">
                      {historyOpen === s.id ? 'Hide history' : 'Version history'}
                    </button>
                    <button type="button" onClick={() => handleEditViaChat(s.id)} className="text-accent text-[13px] font-bold">
                      Edit via Chat →
                    </button>
                  </div>
                </div>

                {expanded === s.id && (
                  <pre className="border-t border-line bg-bg -mx-4 mt-3 p-4 text-[11px] font-mono overflow-x-auto max-h-80 overflow-y-auto">
                    <code>{scriptText[s.id] ?? 'Loading…'}</code>
                  </pre>
                )}

                {historyOpen === s.id && (
                  <div className="border-t border-line mt-3 pt-3">
                    {!versions[s.id] ? (
                      <div className="text-[12px] text-tx-4">Loading…</div>
                    ) : versions[s.id]!.length === 0 ? (
                      <div className="text-[12px] text-tx-4">No saved history yet — this script hasn't been edited.</div>
                    ) : (
                      <ul className="flex flex-col gap-1.5">
                        {versions[s.id]!.map(v => (
                          <li key={v.id} className="flex items-center justify-between text-[12px]">
                            <span className="text-tx-3">{fmtDate(v.createdAt)}</span>
                            <button
                              type="button"
                              onClick={() => handleRestore(s.id, v.id)}
                              disabled={restoring === v.id}
                              className="text-accent font-bold disabled:opacity-50"
                            >
                              {restoring === v.id ? 'Restoring…' : 'Restore'}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
