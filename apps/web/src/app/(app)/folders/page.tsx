'use client';

import { useToast } from '@/components/feedback/Toast';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { buildTree, flatten, type FolderNode, type FolderRow } from '@/lib/folders';
import { errorMessage } from '@/lib/format';
import { hasPermission } from '@/lib/permissions';

/** Which inline editor is open: renaming a folder, or adding a subfolder under one. */
type Editing = { kind: 'rename' | 'child'; id: string } | null;

export default function FoldersPage() {
  const { user } = useAuth();
  const [rows, setRows] = useState<FolderRow[] | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const [newName, setNewName] = useState('');
  const [newParent, setNewParent] = useState('');
  const [editing, setEditing] = useState<Editing>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const canEdit = hasPermission(user, 'folders.edit');

  const load = useCallback(async () => {
    try {
      setRows(await api<FolderRow[]>('/folders'));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(fn: () => Promise<unknown>, done?: string): Promise<boolean> {
    setError(null);
    setBusy(true);
    try {
      await fn();
      await load();
      if (done) toast.success(done);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const tree = buildTree(rows ?? []);
  const options = flatten(tree);
  // sopCount is each folder's own SOPs (not its subfolders'), so the sum counts every filed SOP once.
  const totalSops = (rows ?? []).reduce((n, r) => n + r.sopCount, 0);

  const startEdit = (kind: 'rename' | 'child', n: FolderNode) => {
    setEditing({ kind, id: n.id });
    setDraft(kind === 'rename' ? n.name : '');
    if (kind === 'child') setCollapsed((s) => {
      const next = new Set(s);
      next.delete(n.id);
      return next;
    });
  };

  const submitEdit = async (n: FolderNode) => {
    const name = draft.trim();
    if (!editing || !name) return setEditing(null);
    if (editing.kind === 'rename') {
      if (name === n.name) return setEditing(null);
      if (await run(() => api(`/folders/${n.id}`, { method: 'PATCH', body: { name } }), 'Folder renamed.')) setEditing(null);
    } else if (await run(() => api('/folders', { method: 'POST', body: { name, parentId: n.id } }), `Created ${name}.`)) {
      setEditing(null);
    }
  };

  const inlineInput = (n: FolderNode, placeholder: string) => (
    <form
      className="fd-inline"
      onSubmit={(e) => {
        e.preventDefault();
        void submitEdit(n);
      }}
    >
      <input autoFocus value={draft} placeholder={placeholder} maxLength={100} disabled={busy} aria-label={placeholder} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setEditing(null)} />
      <button className="btn btn-sm btn-primary" type="submit" disabled={busy || !draft.trim()}>Save</button>
      <button className="btn btn-sm" type="button" onClick={() => setEditing(null)}>Cancel</button>
    </form>
  );

  const renderNode = (n: FolderNode) => {
    const isCollapsed = collapsed.has(n.id);
    const renaming = editing?.kind === 'rename' && editing.id === n.id;
    const addingChild = editing?.kind === 'child' && editing.id === n.id;
    return (
      <li key={n.id}>
        <div className="fd-row" style={{ paddingLeft: 10 + n.depth * 24 }}>
          <button
            type="button"
            className="fd-toggle"
            style={{ visibility: n.children.length ? 'visible' : 'hidden' }}
            aria-label={isCollapsed ? `Expand ${n.name}` : `Collapse ${n.name}`}
            aria-expanded={!isCollapsed}
            onClick={() =>
              setCollapsed((s) => {
                const next = new Set(s);
                if (next.has(n.id)) next.delete(n.id);
                else next.add(n.id);
                return next;
              })
            }
          >
            <i className={`fa-solid fa-chevron-${isCollapsed ? 'right' : 'down'}`} aria-hidden />
          </button>
          <i className={`fa-solid ${n.children.length && !isCollapsed ? 'fa-folder-open' : 'fa-folder'} fd-icon`} aria-hidden />
          {renaming ? (
            inlineInput(n, 'Folder name')
          ) : (
            <>
              <Link href={`/sops?folder=${n.id}&sub=1`} className="fd-name">{n.name}</Link>
              <span className="grp-chip">{n.sopCount} SOPs</span>
            </>
          )}
          <div className="spacer" />
          {canEdit && !renaming && (
            <div className="fd-tools">
              <button className="grp-icon-btn" type="button" title="Add subfolder" aria-label={`Add subfolder to ${n.name}`} disabled={busy} onClick={() => startEdit('child', n)}>
                <i className="fa-solid fa-folder-plus" aria-hidden />
              </button>
              <button className="grp-icon-btn" type="button" title="Rename" aria-label={`Rename ${n.name}`} disabled={busy} onClick={() => startEdit('rename', n)}>
                <i className="fa-solid fa-pen" aria-hidden />
              </button>
              <select
                className="inline-select fd-move"
                aria-label={`Move ${n.name}`}
                value=""
                disabled={busy}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v) void run(() => api(`/folders/${n.id}`, { method: 'PATCH', body: { parentId: v === 'root' ? null : v } }), 'Folder moved.');
                }}
              >
                <option value="">Move to…</option>
                <option value="root">(top level)</option>
                {options
                  .filter((o) => o.id !== n.id)
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      {'  '.repeat(o.depth)}
                      {o.name}
                    </option>
                  ))}
              </select>
              <button
                className="grp-icon-btn danger"
                type="button"
                title="Delete"
                aria-label={`Delete ${n.name}`}
                disabled={busy}
                onClick={() => {
                  if (confirm(`Delete folder "${n.name}"? It must be empty.`)) void run(() => api(`/folders/${n.id}`, { method: 'DELETE' }), 'Folder deleted.');
                }}
              >
                <i className="fa-solid fa-trash" aria-hidden />
              </button>
            </div>
          )}
        </div>
        {addingChild && (
          <div className="fd-row fd-row-new" style={{ paddingLeft: 10 + (n.depth + 1) * 24 + 26 }}>
            <i className="fa-solid fa-folder-plus fd-icon" aria-hidden />
            {inlineInput(n, `New subfolder in ${n.name}`)}
          </div>
        )}
        {!isCollapsed && n.children.length > 0 && <ul className="fd-list">{n.children.map(renderNode)}</ul>}
      </li>
    );
  };

  return (
    <>
      <div className="page-head">
        <p className="page-lead">Organise SOPs into folders. Click a folder to see its SOPs, including those in subfolders.</p>
        <div className="page-head-actions">
          <Link href="/sops?folder=root" className="btn">
            <i className="fa-solid fa-file-circle-question" aria-hidden /> SOPs not in a folder
          </Link>
        </div>
      </div>

      {rows && (
        <div className="kpi-grid">
          <div className="kpi">
            <span className="kpi-icon"><i className="fa-solid fa-folder" aria-hidden /></span>
            <span className="kpi-text"><span className="kpi-value">{rows.length}</span><span className="kpi-label">Folders</span></span>
          </div>
          <div className="kpi">
            <span className="kpi-icon"><i className="fa-solid fa-sitemap" aria-hidden /></span>
            <span className="kpi-text"><span className="kpi-value">{tree.length}</span><span className="kpi-label">Top-level folders</span></span>
          </div>
          <div className="kpi">
            <span className="kpi-icon"><i className="fa-solid fa-file-lines" aria-hidden /></span>
            <span className="kpi-text"><span className="kpi-value">{totalSops}</span><span className="kpi-label">SOPs in folders</span></span>
          </div>
        </div>
      )}

      {error && <div className="error">{error}</div>}

      {canEdit && (
        <form
          className="um-card fd-create"
          onSubmit={(e) => {
            e.preventDefault();
            const name = newName.trim();
            if (!name) return;
            void run(() => api('/folders', { method: 'POST', body: { name, parentId: newParent || undefined } }), `Created ${name}.`).then((ok) => ok && setNewName(''));
          }}
        >
          <span className="kpi-icon"><i className="fa-solid fa-folder-plus" aria-hidden /></span>
          <input placeholder="New folder name" aria-label="New folder name" required maxLength={100} value={newName} onChange={(e) => setNewName(e.target.value)} />
          <select aria-label="Parent folder" value={newParent} onChange={(e) => setNewParent(e.target.value)}>
            <option value="">At the top level</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {'  '.repeat(o.depth)}
                Inside {o.name}
              </option>
            ))}
          </select>
          <button className="btn btn-primary" type="submit" disabled={busy || !newName.trim()}>
            <i className="fa-solid fa-plus" aria-hidden /> Create folder
          </button>
        </form>
      )}

      {rows === null && !error && <p className="muted" role="status">Loading folders…</p>}
      {rows !== null && (
        <div className="um-card">
          {tree.length === 0 ? (
            <div className="um-empty">
              <i className="fa-solid fa-folder-open" aria-hidden />
              <p>No folders yet.{canEdit ? ' Create one above.' : ''}</p>
            </div>
          ) : (
            <ul className="fd-list fd-root">{tree.map(renderNode)}</ul>
          )}
        </div>
      )}
    </>
  );
}
