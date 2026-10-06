'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { buildTree, flatten, type FolderNode, type FolderRow } from '@/lib/folders';
import { errorMessage } from '@/lib/format';
import { hasPermission } from '@/lib/permissions';

export default function FoldersPage() {
  const { user } = useAuth();
  const [rows, setRows] = useState<FolderRow[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newParent, setNewParent] = useState('');
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

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const tree = buildTree(rows);
  const options = flatten(tree);

  const renderNode = (n: FolderNode) => {
    const isCollapsed = collapsed.has(n.id);
    return (
      <li key={n.id}>
        <div className="row folder-row" style={{ paddingLeft: n.depth * 20 }}>
          <button
            className="btn btn-sm"
            style={{ visibility: n.children.length ? 'visible' : 'hidden', width: 30, justifyContent: 'center' }}
            onClick={() =>
              setCollapsed((s) => {
                const next = new Set(s);
                if (next.has(n.id)) next.delete(n.id);
                else next.add(n.id);
                return next;
              })
            }
          >
            {isCollapsed ? '▸' : '▾'}
          </button>
          <span>📁</span>
          <Link href={`/sops?folder=${n.id}&sub=1`}>{n.name}</Link>
          <span className="badge">{n.sopCount} SOPs</span>
          <div className="spacer" />
          {canEdit && (
            <>
              <button
                className="btn btn-sm"
                onClick={() => {
                  const name = prompt('Subfolder name');
                  if (name?.trim()) void run(() => api('/folders', { method: 'POST', body: { name, parentId: n.id } }));
                }}
              >
                + Subfolder
              </button>
              <button
                className="btn btn-sm"
                onClick={() => {
                  const name = prompt('Rename folder', n.name);
                  if (name?.trim() && name !== n.name) void run(() => api(`/folders/${n.id}`, { method: 'PATCH', body: { name } }));
                }}
              >
                Rename
              </button>
              <select
                className="btn-sm"
                style={{ width: 150 }}
                value=""
                onChange={(e) => {
                  const v = e.target.value;
                  if (v) void run(() => api(`/folders/${n.id}`, { method: 'PATCH', body: { parentId: v === 'root' ? null : v } }));
                }}
              >
                <option value="">Move to…</option>
                <option value="root">(top level)</option>
                {options
                  .filter((o) => o.id !== n.id)
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      {'  '.repeat(o.depth)}
                      {o.name}
                    </option>
                  ))}
              </select>
              <button
                className="btn btn-sm btn-danger"
                onClick={() => {
                  if (confirm(`Delete folder "${n.name}"? It must be empty.`)) void run(() => api(`/folders/${n.id}`, { method: 'DELETE' }));
                }}
              >
                Delete
              </button>
            </>
          )}
        </div>
        {!isCollapsed && n.children.length > 0 && <ul className="folder-list">{n.children.map(renderNode)}</ul>}
      </li>
    );
  };

  return (
    <>
      <h1>FOLDERS</h1>
      {error && <div className="error">{error}</div>}
      {canEdit && (
        <form
          className="row card"
          style={{ marginBottom: 16 }}
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api('/folders', { method: 'POST', body: { name: newName, parentId: newParent || undefined } });
              setNewName('');
            });
          }}
        >
          <input placeholder="New folder name" required value={newName} onChange={(e) => setNewName(e.target.value)} style={{ width: 260 }} />
          <select value={newParent} onChange={(e) => setNewParent(e.target.value)} style={{ width: 220 }}>
            <option value="">(top level)</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {'  '.repeat(o.depth)}
                {o.name}
              </option>
            ))}
          </select>
          <button className="btn btn-primary" type="submit">
            Create folder
          </button>
        </form>
      )}
      {tree.length === 0 ? (
        <p className="muted">No folders yet.</p>
      ) : (
        <ul className="folder-list card">{tree.map(renderNode)}</ul>
      )}
      <p className="muted" style={{ marginTop: 12 }}>
        <Link href="/sops?folder=root">SOPs not in any folder →</Link>
      </p>
    </>
  );
}
