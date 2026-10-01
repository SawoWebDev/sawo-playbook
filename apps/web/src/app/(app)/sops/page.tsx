'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState, type FormEvent } from 'react';
import { SopCardMenu } from '@/components/SopCardMenu';
import { SopStatusBadge } from '@/components/StatusBadge';
import { Icons, SubbarLeft, SubbarRight } from '@/components/Subbar';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { buildTree, flatten, type FolderRow } from '@/lib/folders';
import { errorMessage, fmtDate } from '@/lib/format';
import { allowed } from '@/lib/permissions';
import type { SopDetail, SopListItem, SopType } from '@/lib/types';

const CREATE_OPTIONS: { type: SopType; label: string; enabled: boolean; note?: string }[] = [
  { type: 'standard', label: 'Standard SOP', enabled: true },
  { type: 'video', label: 'Video SOP', enabled: false, note: 'coming soon' },
  { type: 'advanced', label: 'Advanced SOP', enabled: true },
  { type: 'document', label: 'Upload Document', enabled: false, note: 'coming soon' },
];

export default function SopsPage() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <SopsList />
    </Suspense>
  );
}

function SopsList() {
  const { user } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const [folder, setFolder] = useState(params.get('folder') ?? '');
  const [includeSub, setIncludeSub] = useState(params.get('sub') === '1');
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [newFolder, setNewFolder] = useState('');
  const [items, setItems] = useState<SopListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [creating, setCreating] = useState<SopType | null>(null);
  const [newName, setNewName] = useState('');
  const [newRef, setNewRef] = useState('');

  const PAGE = 48;
  const load = useCallback(
    async (offset = 0) => {
      const q = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
      if (search.trim()) q.set('search', search.trim());
      if (status) q.set('status', status);
      if (folder) q.set('folderId', folder);
      if (folder && folder !== 'root' && includeSub) q.set('includeSubfolders', 'true');
      try {
        const r = await api<{ total: number; items: SopListItem[] }>(`/sops?${q}`);
        setItems((prev) => (offset ? [...prev, ...r.items] : r.items));
        setTotal(r.total);
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [search, status, folder, includeSub],
  );

  useEffect(() => {
    api<FolderRow[]>('/folders').then(setFolders).catch(() => undefined);
  }, []);

  useEffect(() => {
    const q = new URLSearchParams();
    if (folder) q.set('folder', folder);
    if (includeSub) q.set('sub', '1');
    router.replace(`/sops${q.size ? `?${q}` : ''}`, { scroll: false });
  }, [folder, includeSub, router]);

  const folderOptions = flatten(buildTree(folders));

  useEffect(() => {
    const t = setTimeout(() => load(0), 250);
    return () => clearTimeout(t);
  }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      const sop = await api<SopDetail>('/sops', {
        method: 'POST',
        body: { name: newName, type: creating, referenceNo: newRef.trim() || undefined, folderId: newFolder || undefined },
      });
      router.push(`/sops/${sop.id}/edit/${sop.activeVersionId}`);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const canCreate = allowed(user?.role, 'editSops');

  return (
    <>
      <SubbarLeft>
        {canCreate && (
          <div className="menu">
            <button className="btn btn-orange" onClick={() => setMenuOpen((o) => !o)}>
              + Create New
            </button>
            {menuOpen && (
              <div className="menu-list" style={{ left: 0, right: 'auto' }} onMouseLeave={() => setMenuOpen(false)}>
                {CREATE_OPTIONS.map((o) => (
                  <button
                    key={o.type}
                    disabled={!o.enabled}
                    onClick={() => {
                      setCreating(o.type);
                      setMenuOpen(false);
                    }}
                  >
                    {o.label} {o.note && <span className="muted">({o.note})</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </SubbarLeft>
      <SubbarRight>
        <Link href="/folders" className="icon-btn" aria-label="Folders" title="Folders">
          {Icons.folder}
        </Link>
        <button className={`icon-btn ${showFilters ? 'on' : ''}`} aria-label="Filter" title="Filter" onClick={() => setShowFilters((o) => !o)}>
          {Icons.filter}
        </button>
      </SubbarRight>

      <div className="row" style={{ marginBottom: 8 }}>
        <input placeholder="Search name or reference…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 260 }} />
        {showFilters && (
          <>
            <select value={folder} onChange={(e) => setFolder(e.target.value)} style={{ width: 200 }}>
              <option value="">All folders</option>
              <option value="root">(not in a folder)</option>
              {folderOptions.map((f) => (
                <option key={f.id} value={f.id}>
                  {'  '.repeat(f.depth)}
                  {f.name}
                </option>
              ))}
            </select>
            {folder && folder !== 'root' && (
              <label className="row" style={{ margin: 0, fontWeight: 400, gap: 4 }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={includeSub} onChange={(e) => setIncludeSub(e.target.checked)} />
                subfolders
              </label>
            )}
            <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 170 }}>
              <option value="">All (not archived)</option>
              <option value="published">Published</option>
              <option value="draft">Draft</option>
              <option value="pending_approval">Pending approval</option>
              <option value="approved">Approved</option>
              <option value="archived">Archived</option>
            </select>
          </>
        )}
      </div>
      {error && <div className="error">{error}</div>}
      {notice && <div className="success">{notice}</div>}

      {items.length === 0 ? (
        <p className="muted">No procedures found.</p>
      ) : (
        <div className="sop-grid">
          {items.map((s) => (
            <div key={s.id} className="sop-tile">
              <Link href={`/sops/${s.id}`} className="sop-card">
                <div className="name" title={s.name}>
                  {s.name}
                </div>
                {s.status !== 'published' && (
                  <span className="badge">
                    {s.activeVersion?.rejected ? (
                      <span className="badge badge-red">Rejected</span>
                    ) : (
                      <SopStatusBadge status={s.status} approvals={s.activeVersion?.approvals} quorum={s.activeVersion?.quorum} />
                    )}
                  </span>
                )}
                <div className="line">Reference No: <b>{s.referenceNo}</b></div>
                <div className="line">Folder: <b>{s.folder?.name ?? 'N/A'}</b></div>
                <div className="line">Date Raised: <b>{fmtDate(s.createdAt)}</b></div>
                <div className="line">Created By: <b>{s.createdBy?.name ?? 'N/A'}</b></div>
                <div className="line">Last Modified: <b>{fmtDate(s.updatedAt)}</b></div>
              </Link>
              <SopCardMenu
                sop={s}
                folders={folderOptions}
                onError={setError}
                onChanged={(msg) => {
                  setNotice(msg ?? null);
                  void load(0);
                }}
              />
            </div>
          ))}
        </div>
      )}
      {items.length < total && (
        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <button className="btn" onClick={() => load(items.length)}>
            Load more ({total - items.length} remaining)
          </button>
        </div>
      )}

      {creating && (
        <div className="dialog-backdrop" onClick={() => setCreating(null)}>
          <form className="card dialog" onClick={(e) => e.stopPropagation()} onSubmit={create}>
            <h3 style={{ marginTop: 0 }}>New {creating === 'advanced' ? 'Advanced' : 'Standard'} SOP</h3>
            <div className="field">
              <label htmlFor="n">Procedure name</label>
              <input id="n" autoFocus required value={newName} onChange={(e) => setNewName(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="f">Folder</label>
              <select id="f" value={newFolder} onChange={(e) => setNewFolder(e.target.value)}>
                <option value="">(none)</option>
                {folderOptions.map((f) => (
                  <option key={f.id} value={f.id}>
                    {'  '.repeat(f.depth)}
                    {f.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="r">Reference No. (leave blank to auto-number)</label>
              <input id="r" value={newRef} onChange={(e) => setNewRef(e.target.value)} />
            </div>
            <div className="row">
              <div className="spacer" />
              <button type="button" className="btn" onClick={() => setCreating(null)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary">
                Create
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
