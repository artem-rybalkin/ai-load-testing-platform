import { useState } from 'react';
import { useLoaderData, useRevalidator } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
import { useWorkspace } from '@/lib/WorkspaceContext';
import { createWorkspace, updateWorkspace, deleteWorkspace, getWorkspaces, type Workspace } from '@/lib/api';

export async function loader(): Promise<{ workspaces: Workspace[] }> {
  return getWorkspaces();
}

export default function WorkspacesPage() {
  const { user } = useAuth();
  const { activeWorkspaceId, setActiveWorkspaceId, refetch } = useWorkspace();
  const { workspaces } = useLoaderData() as { workspaces: Workspace[] };
  const revalidator = useRevalidator();
  const role = user?.role;

  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editError, setEditError] = useState('');

  // Refreshes both this page's own loader-backed view and the shared
  // WorkspaceContext the sidebar switcher reads from — they're independent
  // fetches of the same underlying list, so a mutation here needs both.
  const refreshAll = async (): Promise<void> => {
    await Promise.all([revalidator.revalidate(), refetch()]);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true); setError('');
    try {
      await createWorkspace({ name: newName.trim(), description: newDesc.trim() || undefined });
      setNewName(''); setNewDesc('');
      await refreshAll();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const startEdit = (w: Workspace) => {
    setEditingId(w.id); setEditName(w.name); setEditDesc(w.description ?? ''); setEditError('');
  };

  const handleSaveEdit = async (id: string) => {
    setEditError('');
    try {
      await updateWorkspace(id, { name: editName.trim(), description: editDesc.trim() || undefined });
      setEditingId(null);
      await refreshAll();
    } catch (err) {
      setEditError((err as Error).message);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete project "${name}"? Resources in it will become unassigned.`)) return;
    try {
      await deleteWorkspace(id);
      if (activeWorkspaceId === id) setActiveWorkspaceId(null);
      await refreshAll();
    } catch (err) {
      alert((err as Error).message);
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-6 py-8">
      <h1 className="text-[22px] font-bold mb-1">Projects</h1>
      <p className="text-sm text-[#57606a] mb-6">
        Organize test results, scripts, presets, schedules, and webhooks into named projects within this team.
        Select a project in the sidebar to filter all views.
      </p>

      {/* Create form */}
      {role !== 'viewer' && (
        <form onSubmit={handleCreate} className="bg-[#f6f8fa] border border-[#d0d7de] rounded-[10px] p-4 mb-6">
          <h2 className="text-[14px] font-semibold mb-3">New project</h2>
          <div className="flex gap-2 mb-2">
            <input
              type="text"
              placeholder="Project name"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              className="flex-1 border border-[#d0d7de] rounded-md px-3 py-1.5 text-sm focus:outline-none focus:border-[#0969da]"
              maxLength={80}
            />
            <input
              type="text"
              placeholder="Description (optional)"
              value={newDesc}
              onChange={e => setNewDesc(e.target.value)}
              className="flex-1 border border-[#d0d7de] rounded-md px-3 py-1.5 text-sm focus:outline-none focus:border-[#0969da]"
              maxLength={200}
            />
            <button
              type="submit"
              disabled={creating || !newName.trim()}
              className="bg-[#1f883d] text-white text-sm font-medium px-4 py-1.5 rounded-md disabled:opacity-50"
            >
              {creating ? 'Creating…' : 'Create'}
            </button>
          </div>
          {error && <p className="text-xs text-[#cf222e] mt-1">{error}</p>}
        </form>
      )}

      {/* Project list */}
      {workspaces.length === 0 ? (
        <div className="text-sm text-[#57606a] border border-[#d0d7de] rounded-[10px] p-6 text-center">
          No projects yet. Create one above to start organizing your tests.
        </div>
      ) : (
        <ul className="border border-[#d0d7de] rounded-[10px] divide-y divide-[#d0d7de] overflow-hidden">
          {workspaces.map(w => (
            <li key={w.id} className={`px-4 py-3 flex items-start gap-3 ${activeWorkspaceId === w.id ? 'bg-[#ddf4ff]' : 'bg-white'}`}>
              {editingId === w.id ? (
                <div className="flex-1 flex flex-col gap-1.5">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      className="flex-1 border border-[#d0d7de] rounded-md px-2.5 py-1 text-sm focus:outline-none focus:border-[#0969da]"
                      maxLength={80}
                      autoFocus
                    />
                    <input
                      type="text"
                      value={editDesc}
                      onChange={e => setEditDesc(e.target.value)}
                      placeholder="Description"
                      className="flex-1 border border-[#d0d7de] rounded-md px-2.5 py-1 text-sm focus:outline-none focus:border-[#0969da]"
                      maxLength={200}
                    />
                  </div>
                  {editError && <p className="text-xs text-[#cf222e]">{editError}</p>}
                  <div className="flex gap-2">
                    <button onClick={() => handleSaveEdit(w.id)} className="text-xs bg-[#0969da] text-white px-3 py-1 rounded-md">Save</button>
                    <button onClick={() => setEditingId(null)} className="text-xs text-[#57606a] px-3 py-1 rounded-md border border-[#d0d7de]">Cancel</button>
                  </div>
                </div>
              ) : (
                <>
                  <button
                    onClick={() => setActiveWorkspaceId(activeWorkspaceId === w.id ? null : w.id)}
                    className="mt-0.5 w-4 h-4 rounded-full border-2 flex-shrink-0 transition-colors"
                    style={{ borderColor: activeWorkspaceId === w.id ? '#0969da' : '#d0d7de', background: activeWorkspaceId === w.id ? '#0969da' : 'white' }}
                    title={activeWorkspaceId === w.id ? 'Deselect project' : 'Set as active project'}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{w.name}</span>
                      {activeWorkspaceId === w.id && (
                        <span className="text-[10px] font-semibold bg-[#0969da] text-white px-1.5 py-0.5 rounded-full uppercase tracking-wide">Active</span>
                      )}
                    </div>
                    {w.description && <p className="text-xs text-[#57606a] mt-0.5">{w.description}</p>}
                    <p className="text-[11px] text-[#8c959f] mt-0.5 font-mono">{w.createdAt.slice(0, 10)}</p>
                  </div>
                  <div className="flex gap-1.5">
                    {role !== 'viewer' && (
                      <button onClick={() => startEdit(w)} className="text-xs text-[#57606a] hover:text-[#0969da] px-2 py-1 rounded border border-[#d0d7de]">Edit</button>
                    )}
                    {role === 'admin' && (
                      <button onClick={() => handleDelete(w.id, w.name)} className="text-xs text-[#cf222e] hover:bg-[#fff8f8] px-2 py-1 rounded border border-[#d0d7de]">Delete</button>
                    )}
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
