'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { OptButton } from '@/components/OptButton';
import { Item, SopCardMenu } from '@/components/SopCardMenu';
import { SopStatusBadge } from '@/components/StatusBadge';
import { Icons, SubbarLeft, SubbarRight } from '@/components/Subbar';
import { api, apiRaw } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { buildTree, flatten, type FolderRow } from '@/lib/folders';
import { errorMessage, fmtListDate } from '@/lib/format';
import { allowed } from '@/lib/permissions';
import type { SopDetail, SopListItem, SopType } from '@/lib/types';

const SORT_OPTIONS = [
  { value: 'oldest', label: 'Oldest' },
  { value: 'newest', label: 'Newest' },
  { value: 'modified', label: 'Date Modified' },
  { value: 'alphabetical', label: 'Alphabetical' },
  { value: 'reference', label: 'Reference No' },
];

const TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'All types' },
  { value: 'standard', label: 'Standard SOP' },
  { value: 'advanced', label: 'Advanced SOP' },
  { value: 'video', label: 'Video SOP' },
  { value: 'document', label: 'Document' },
];

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'All (not archived)' },
  { value: 'published', label: 'Published' },
  { value: 'draft', label: 'Draft' },
  { value: 'pending_approval', label: 'Pending approval' },
  { value: 'approved', label: 'Approved' },
  { value: 'archived', label: 'Archived' },
];

type View = 'grid' | 'list';
type Popover = 'sort' | 'filter' | 'view' | null;
interface Creator {
  id: string;
  name: string;
}

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
  const [items, setItems] = useState<SopListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [roster, setRoster] = useState<Creator[]>([]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [checklistOnly, setChecklistOnly] = useState(false);
  const [creatorIds, setCreatorIds] = useState<string[]>([]);
  const [sort, setSort] = useState('newest');
  const [view, setView] = useState<View>('grid');
  const [popover, setPopover] = useState<Popover>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState<SopType | null>(null);
  const [newName, setNewName] = useState('');
  const [newRef, setNewRef] = useState('');
  const [newFolder, setNewFolder] = useState('');
  const [showImport, setShowImport] = useState(false);

  const creatorKey = creatorIds.join(',');
  const PAGE = 48;
  const load = useCallback(
    async (offset = 0) => {
      const q = new URLSearchParams({ limit: String(PAGE), offset: String(offset), sort });
      if (search.trim()) q.set('search', search.trim());
      if (status) q.set('status', status);
      if (type) q.set('type', type);
      if (checklistOnly) q.set('checklistOnly', 'true');
      if (creatorKey) q.set('createdBy', creatorKey);
      if (folder) q.set('folderId', folder);
      if (folder && folder !== 'root' && includeSub) q.set('includeSubfolders', 'true');
      try {
        const r = await api<{ total: number; items: SopListItem[]; facets: { creators: Creator[] } }>(`/sops?${q}`);
        setItems((prev) => (offset ? [...prev, ...r.items] : r.items));
        setTotal(r.total);
        if (!offset) setRoster(r.facets.creators);
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [search, status, type, checklistOnly, creatorKey, sort, folder, includeSub],
  );

  useEffect(() => {
    api<FolderRow[]>('/folders').then(setFolders).catch(() => undefined);
    try {
      const v = localStorage.getItem('sops-view');
      if (v === 'grid' || v === 'list') setView(v);
    } catch {
      /* storage unavailable: keep the default view */
    }
  }, []);

  useEffect(() => {
    const q = new URLSearchParams();
    if (folder) q.set('folder', folder);
    if (includeSub) q.set('sub', '1');
    router.replace(`/sops${q.size ? `?${q}` : ''}`, { scroll: false });
  }, [folder, includeSub, router]);

  useEffect(() => {
    const t = setTimeout(() => {
      setSelected(new Set());
      void load(0);
    }, 250);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    if (!popover) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.menu')) setPopover(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [popover]);

  const hasMore = items.length < total;
  const sentinel = useRef<HTMLDivElement>(null);
  const loadingMore = useRef(false);
  useEffect(() => {
    loadingMore.current = false;
  }, [items.length]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting || loadingMore.current) return;
        loadingMore.current = true;
        void load(items.length).finally(() => {
          loadingMore.current = false;
        });
      },
      { rootMargin: '300px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, items.length, load]);

  const folderOptions = flatten(buildTree(folders));
  const canCreate = allowed(user?.role, 'editSops');
  const togglePopover = (p: Exclude<Popover, null>) => setPopover((cur) => (cur === p ? null : p));
  const activeFilters = [status, type, folder, checklistOnly ? '1' : '', creatorKey].filter(Boolean).length;

  function clearFilters() {
    setStatus('');
    setType('');
    setFolder('');
    setIncludeSub(false);
    setChecklistOnly(false);
    setCreatorIds([]);
  }

  function changeView(v: View) {
    setView(v);
    try {
      localStorage.setItem('sops-view', v);
    } catch {
      /* storage unavailable: the choice applies for this session only */
    }
    setPopover(null);
  }

  function toggleSelected(id: string) {
    setSelected((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function toggleCreator(id: string) {
    setCreatorIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

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

  const isManager = allowed(user?.role, 'manageSettings');

  /** Starts a full backup and shows its live progress in a new tab (opened first so the click isn't treated as a popup). */
  async function startBackup() {
    setError(null);
    const tab = window.open('about:blank', '_blank');
    try {
      const job = await api<{ id: string }>('/backups', { method: 'POST' });
      const url = `/backups?job=${job.id}`;
      if (tab) tab.location.href = url;
      else router.push(url);
    } catch (e) {
      tab?.close();
      setError(errorMessage(e));
    }
  }

  async function exportCsv() {
    setError(null);
    const res = await apiRaw('/sops/export.csv');
    if (!res.ok) return setError(`Export failed (${res.status})`);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sops.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  const selectable = (id: string) =>
    canCreate ? (
      <input
        type="checkbox"
        className="sop-check"
        aria-label="Select SOP"
        checked={selected.has(id)}
        onChange={() => toggleSelected(id)}
      />
    ) : null;

  return (
    <>
      <SubbarRight>
        <div className="subbar-search">
          {Icons.search}
          <input placeholder="Search name or reference…" aria-label="Search SOPs" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="menu">
          <button className={`icon-btn ${popover === 'sort' ? 'on' : ''}`} aria-label="Sort" title="Sort" onClick={() => togglePopover('sort')}>
            {Icons.sort}
          </button>
          {popover === 'sort' && (
            <div className="menu-list icon-menu sort-menu">
              <div className="menu-heading">Sort by</div>
              {SORT_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  className={sort === o.value ? 'active' : ''}
                  onClick={() => {
                    setSort(o.value);
                    setPopover(null);
                  }}
                >
                  <span>{o.label}</span>
                  {sort === o.value && <span className="note">✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="menu">
          <button
            className={`icon-btn ${popover === 'filter' || activeFilters ? 'on' : ''}`}
            aria-label="Filter"
            title="Filter"
            onClick={() => togglePopover('filter')}
          >
            {Icons.filter}
            {activeFilters > 0 && <span className="filter-count">{activeFilters}</span>}
          </button>
          {popover === 'filter' && (
            <div className="menu-list filter-panel">
              <div className="filter-group">
                <div className="filter-title">Type</div>
                <select aria-label="Type" value={type} onChange={(e) => setType(e.target.value)}>
                  {TYPE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="filter-group">
                <div className="filter-title">Status</div>
                <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
                  {STATUS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="filter-group">
                <div className="filter-title">Folder</div>
                <select aria-label="Folder" value={folder} onChange={(e) => setFolder(e.target.value)}>
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
                  <label className="filter-check">
                    <input type="checkbox" checked={includeSub} onChange={(e) => setIncludeSub(e.target.checked)} />
                    include subfolders
                  </label>
                )}
              </div>
              <div className="filter-group">
                <label className="filter-check">
                  <input type="checkbox" checked={checklistOnly} onChange={(e) => setChecklistOnly(e.target.checked)} />
                  Checklist SOPs
                </label>
              </div>
              <div className="filter-group">
                <div className="filter-title">Created By</div>
                {roster.length === 0 ? (
                  <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                    No creators yet.
                  </p>
                ) : (
                  <div className="filter-scroll">
                    {roster.map((c) => (
                      <label key={c.id} className="filter-check">
                        <input type="checkbox" checked={creatorIds.includes(c.id)} onChange={() => toggleCreator(c.id)} />
                        {c.name}
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <div className="filter-foot">
                <button className="btn btn-sm" disabled={!activeFilters} onClick={clearFilters}>
                  Clear all
                </button>
              </div>
            </div>
          )}
        </div>
        <Link href="/folders" className="icon-btn" aria-label="Folders" title="Folders">
          {Icons.folder}
        </Link>
        <div className="menu">
          <button className={`icon-btn view-kebab ${popover === 'view' ? 'on' : ''}`} aria-label="View options" title="View options" onClick={() => togglePopover('view')}>
            ⋮
          </button>
          {popover === 'view' && (
            <div className="menu-list icon-menu">
              <div className="menu-heading">Import / Export</div>
              {canCreate && (
                <Item
                  icon={Icons.upload}
                  label="Bulk import (CSV)"
                  onClick={() => {
                    setPopover(null);
                    setShowImport(true);
                  }}
                />
              )}
              {isManager ? (
                <Item
                  icon={Icons.download}
                  label="Export full backup"
                  onClick={() => {
                    setPopover(null);
                    void startBackup();
                  }}
                />
              ) : (
                <Item
                  icon={Icons.download}
                  label="Export CSV"
                  onClick={() => {
                    setPopover(null);
                    void exportCsv();
                  }}
                />
              )}
            </div>
          )}
        </div>
        <div className="view-toggle" role="group" aria-label="View">
          <button className={`icon-btn ${view === 'grid' ? 'on' : ''}`} aria-label="Grid view" aria-pressed={view === 'grid'} title="Grid view" onClick={() => changeView('grid')}>
            {Icons.gridView}
          </button>
          <button className={`icon-btn ${view === 'list' ? 'on' : ''}`} aria-label="List view" aria-pressed={view === 'list'} title="List view" onClick={() => changeView('list')}>
            {Icons.listView}
          </button>
        </div>
        {canCreate && (
          <OptButton inline onClick={() => setCreating('standard')}>
            + Create New
          </OptButton>
        )}
      </SubbarRight>

      {selected.size > 0 && (
        <div className="row select-bar">
          <strong>{selected.size} selected</strong>
          {canCreate && (
            <button className="btn btn-sm" onClick={() => setBulkOpen(true)}>
              Bulk edit
            </button>
          )}
          <button className="btn btn-sm" onClick={() => setSelected(new Set(items.map((i) => i.id)))}>
            Select all loaded
          </button>
          <button className="btn btn-sm" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {notice && <div className="success">{notice}</div>}

      {items.length === 0 ? (
        <p className="muted">No procedures found.</p>
      ) : view === 'grid' ? (
        <div className={`sop-grid${selected.size ? ' selecting' : ''}`}>
          {items.map((s) => (
            <div key={s.id} className={`sop-tile${selected.has(s.id) ? ' is-selected' : ''}`}>
              {selectable(s.id)}
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
                <div className="line">Date Raised: <b>{fmtListDate(s.createdAt)}</b></div>
                <div className="line">Created By: <b>{s.createdBy?.name ?? 'N/A'}</b></div>
                <div className="line">Last Modified: <b>{fmtListDate(s.updatedAt)}</b></div>
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
      ) : (
        <div className="sop-list-wrap">
          <table className="table sop-list">
            <thead>
              <tr>
                {canCreate && <th className="sop-list-check" />}
                <th>Name</th>
                <th>Reference No</th>
                <th>Folder</th>
                <th>Status</th>
                <th>Date Raised</th>
                <th>Created By</th>
                <th>Last Modified</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id} className={selected.has(s.id) ? 'selected' : ''}>
                  {canCreate && <td>{selectable(s.id)}</td>}
                  <td>
                    <Link href={`/sops/${s.id}`}>{s.name}</Link>
                  </td>
                  <td>{s.referenceNo}</td>
                  <td>{s.folder?.name ?? 'N/A'}</td>
                  <td>
                    {s.activeVersion?.rejected ? (
                      <span className="badge badge-red">Rejected</span>
                    ) : (
                      <SopStatusBadge status={s.status} approvals={s.activeVersion?.approvals} quorum={s.activeVersion?.quorum} />
                    )}
                  </td>
                  <td>{fmtListDate(s.createdAt)}</td>
                  <td>{s.createdBy?.name ?? 'N/A'}</td>
                  <td>{fmtListDate(s.updatedAt)}</td>
                  <td>
                    <SopCardMenu
                      sop={s}
                      folders={folderOptions}
                      onError={setError}
                      onChanged={(msg) => {
                        setNotice(msg ?? null);
                        void load(0);
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {hasMore && (
        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <button className="btn" onClick={() => load(items.length)}>
            Load more ({total - items.length} remaining)
          </button>
          <div ref={sentinel} aria-hidden style={{ height: 1 }} />
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
                    {'  '.repeat(f.depth)}
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

      {showImport && (
        <div className="dialog-backdrop" onClick={() => setShowImport(false)}>
          <ImportDialog
            onClose={(msg) => {
              setShowImport(false);
              if (msg) setNotice(msg);
              void load(0);
            }}
          />
        </div>
      )}

      {bulkOpen && (
        <div className="dialog-backdrop" onClick={() => setBulkOpen(false)}>
          <BulkEditDialog
            ids={[...selected]}
            folders={folderOptions}
            onClose={(msg) => {
              setBulkOpen(false);
              if (msg) {
                setNotice(msg);
                setSelected(new Set());
              }
              void load(0);
            }}
          />
        </div>
      )}
    </>
  );
}

function BulkEditDialog({ ids, folders, onClose }: { ids: string[]; folders: { id: string; name: string; depth: number }[]; onClose: (msg?: string) => void }) {
  const [folderChoice, setFolderChoice] = useState('__keep');
  const [archiveChoice, setArchiveChoice] = useState('__keep');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply(e: FormEvent) {
    e.preventDefault();
    const patch: { folderId?: string | null; archived?: boolean } = {};
    if (folderChoice === 'root') patch.folderId = null;
    else if (folderChoice !== '__keep') patch.folderId = folderChoice;
    if (archiveChoice !== '__keep') patch.archived = archiveChoice === 'archive';
    if (!Object.keys(patch).length) return setError('Choose at least one change.');
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ updated: number }>('/sops/bulk', { method: 'PATCH', body: { ids, patch } });
      onClose(`${r.updated} SOP${r.updated === 1 ? '' : 's'} updated.`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form className="card dialog" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()} onSubmit={apply}>
      <h3 style={{ marginTop: 0 }}>
        Bulk edit {ids.length} SOP{ids.length === 1 ? '' : 's'}
      </h3>
      <p className="muted">Only the fields you change are updated.</p>
      <div className="field">
        <label htmlFor="bulk-folder">Move to folder</label>
        <select id="bulk-folder" value={folderChoice} onChange={(e) => setFolderChoice(e.target.value)}>
          <option value="__keep">— keep current —</option>
          <option value="root">(not in a folder)</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {'  '.repeat(f.depth)}
              {f.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="bulk-archive">Archive status</label>
        <select id="bulk-archive" value={archiveChoice} onChange={(e) => setArchiveChoice(e.target.value)}>
          <option value="__keep">— keep current —</option>
          <option value="archive">Archive</option>
          <option value="unarchive">Unarchive</option>
        </select>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="row">
        <div className="spacer" />
        <button type="button" className="btn" onClick={() => onClose()}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Apply
        </button>
      </div>
    </form>
  );
}

const SOP_TEMPLATE_CSV = 'name,reference_no,type,folder\nClean the conveyor belt,,standard,\n';

function ImportDialog({ onClose }: { onClose: (msg?: string) => void }) {
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<{ imported: number; valid: number; errors: { row: number; error: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(dryRun: boolean) {
    setError(null);
    try {
      const r = await api<NonNullable<typeof result>>('/sops/bulk/import', { method: 'POST', body: { csv, dryRun } });
      setResult(r);
      if (!dryRun && r.imported > 0) onClose(`${r.imported} SOPs imported.`);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <div className="card dialog" style={{ maxWidth: 680 }} onClick={(e) => e.stopPropagation()}>
      <h3 style={{ marginTop: 0 }}>Bulk import SOPs (CSV)</h3>
      <p className="muted">
        Creates a new, empty draft SOP for each row — add steps afterwards. The import is all-or-nothing: nothing is saved unless every row is valid.{' '}
        <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(SOP_TEMPLATE_CSV)}`} download="sop-template.csv">
          Download template
        </a>
      </p>
      <input type="file" accept=".csv,text/csv" style={{ border: 0, padding: 0, marginBottom: 8 }} onChange={async (e) => setCsv((await e.target.files?.[0]?.text()) ?? '')} />
      <textarea rows={8} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder="…or paste CSV here" style={{ fontSize: 12 }} />
      {error && <div className="error">{error}</div>}
      {result && (
        <div className={result.errors.length ? 'error' : 'success'}>
          {result.errors.length ? (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {result.errors.slice(0, 50).map((e) => (
                <li key={e.row}>
                  Row {e.row}: {e.error}
                </li>
              ))}
            </ul>
          ) : (
            `${result.valid} rows are valid and ready to import.`
          )}
        </div>
      )}
      <div className="row" style={{ marginTop: 12 }}>
        <div className="spacer" />
        <button className="btn" onClick={() => onClose()}>
          Cancel
        </button>
        <button className="btn" disabled={!csv.trim()} onClick={() => run(true)}>
          Validate
        </button>
        <button className="btn btn-primary" disabled={!csv.trim()} onClick={() => run(false)}>
          Import
        </button>
      </div>
    </div>
  );
}
