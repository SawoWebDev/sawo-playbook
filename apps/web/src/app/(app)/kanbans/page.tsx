'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { KanbanCardMenu } from '@/components/KanbanCardMenu';
import type { Kanban } from '@/components/KanbanForm';
import { Lightbox, type LightboxImage } from '@/components/Lightbox';
import { OptButton } from '@/components/OptButton';
import { Icons, SubbarRight } from '@/components/Subbar';
import { Item } from '@/components/SopCardMenu';
import { api, apiRaw } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage, fmtListDate } from '@/lib/format';
import { kanbanTitle } from '@/lib/kanban';
import { allowed } from '@/lib/permissions';

interface ListResponse {
  total: number;
  facets: { tags: string[]; suppliers: string[]; locations: string[] };
  items: Kanban[];
}

interface Filters {
  creators: string[] | null;
  tags: string[] | null;
  colors: string[] | null;
}
const NO_FILTER: Filters = { creators: null, tags: null, colors: null };
const NO_TAG = 'NO TAG';
const DEFAULT_COLOR = '#b0825e';
const SORT_OPTIONS = [
  { key: 'oldest', label: 'Oldest', sort: 'createdAt', dir: 'asc' },
  { key: 'newest', label: 'Newest', sort: 'createdAt', dir: 'desc' },
  { key: 'modified', label: 'Date Modified', sort: 'updatedAt', dir: 'desc' },
  { key: 'alpha', label: 'Alphabetical', sort: 'partDescription', dir: 'asc' },
  { key: 'part', label: 'Part Number Order', sort: 'partCode', dir: 'asc' },
] as const;

type Dialog = { kind: 'import' } | { kind: 'bulk' } | null;

export default function KanbansPage() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <Kanbans />
    </Suspense>
  );
}

function Kanbans() {
  const initialSearch = useSearchParams().get('search') ?? '';
  const { user } = useAuth();
  const router = useRouter();
  const canEdit = allowed(user?.role, 'editKanbans');
  const [data, setData] = useState<ListResponse | null>(null);
  const [q, setQ] = useState(() => ({
    search: initialSearch,
    sort: 'createdAt', // newest first, like gembadocs
    dir: 'desc',
  }));
  const [flt, setFlt] = useState<Filters>(NO_FILTER);
  const [draft, setDraft] = useState<Filters>(NO_FILTER);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<Dialog>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [popup, setPopup] = useState<LightboxImage | null>(null);
  const [popover, setPopover] = useState<'sort' | 'filter' | null>(null);
  const [showMore, setShowMore] = useState(false);

  const load = useCallback(async () => {
    const p = new URLSearchParams({ limit: '500' });
    Object.entries(q).forEach(([k, v]) => v && p.set(k, v));
    try {
      const first = await api<ListResponse>(`/kanbans?${p}`);
      // the API returns at most 500 per request; fetch the rest so no kanban is hidden
      while (first.items.length < first.total) {
        p.set('offset', String(first.items.length));
        const next = await api<ListResponse>(`/kanbans?${p}`);
        if (!next.items.length) break;
        first.items.push(...next.items);
      }
      setData(first);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [q]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  const options = useMemo(() => {
    const all = data?.items ?? [];
    return {
      creators: [...new Set(all.map((k) => k.createdBy?.name ?? 'N/A'))].sort((a, b) => a.localeCompare(b)),
      tags: [...new Set(all.map((k) => k.tag ?? NO_TAG))].sort((a, b) => (a === NO_TAG ? 1 : b === NO_TAG ? -1 : a.localeCompare(b))),
      colors: [...new Set(all.map((k) => (k.color || DEFAULT_COLOR).toLowerCase()))].sort(),
    };
  }, [data]);
  const items = useMemo(
    () =>
      (data?.items ?? []).filter(
        (k) =>
          (!flt.creators || flt.creators.includes(k.createdBy?.name ?? 'N/A')) &&
          (!flt.tags || flt.tags.includes(k.tag ?? NO_TAG)) &&
          (!flt.colors || flt.colors.includes((k.color || DEFAULT_COLOR).toLowerCase())),
      ),
    [data, flt],
  );
  const activeFilters = [flt.creators, flt.tags, flt.colors].filter(Boolean).length;
  const sortKey = SORT_OPTIONS.find((o) => o.sort === q.sort && o.dir === q.dir)?.key;

  /** A checkbox group where `null` means "everything is ticked". */
  const isOn = (key: keyof Filters, v: string) => !draft[key] || draft[key]!.includes(v);
  const flip = (key: keyof Filters, v: string, all: string[]) =>
    setDraft((d) => {
      const cur = d[key] ?? all;
      const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
      return { ...d, [key]: next.length === all.length ? null : next };
    });
  const togglePopover = (p: 'sort' | 'filter') => {
    if (p === 'filter' && popover !== 'filter') setDraft(flt);
    setPopover((cur) => (cur === p ? null : p));
  };

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  async function printSelected() {
    setError(null);
    const res = await apiRaw('/kanbans/bulk/print', { method: 'POST', body: { ids: [...selected] } });
    if (!res.ok) return setError(`Print failed (${res.status})`);
    const url = URL.createObjectURL(await res.blob());
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async function exportCsv() {
    const res = await apiRaw('/kanbans/export.csv');
    if (!res.ok) return setError(`Export failed (${res.status})`);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = 'kanbans.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  const setField = (k: 'search') => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setQ({ ...q, [k]: e.target.value });

  return (
    <>
      <SubbarRight>
        <div className="subbar-search">
          {Icons.search}
          <input placeholder="Search part, supplier, tag…" aria-label="Search kanbans" value={q.search} onChange={setField('search')} />
        </div>
        <div className="menu">
          <button className={`icon-btn ${popover === 'sort' ? 'on' : ''}`} aria-label="Sort" title="Sort" onClick={() => togglePopover('sort')}>
            {Icons.sort}
          </button>
          {popover === 'sort' && (
            <div className="menu-list sort-panel" onMouseLeave={() => setPopover(null)}>
              <div className="filter-title muted-title">Sort by</div>
              {SORT_OPTIONS.map((o) => (
                <label key={o.key} className="filter-check">
                  <input
                    type="radio"
                    name="kanban-sort"
                    checked={sortKey === o.key}
                    onChange={() => {
                      setQ((cur) => ({ ...cur, sort: o.sort, dir: o.dir }));
                      setPopover(null);
                    }}
                  />
                  {o.label}
                </label>
              ))}
            </div>
          )}
        </div>
        <div className="menu">
          <button className={`icon-btn ${popover === 'filter' || activeFilters ? 'on' : ''}`} aria-label="Filter" title="Filter" onClick={() => togglePopover('filter')}>
            {Icons.filter}
            {activeFilters > 0 && <span className="filter-count">{activeFilters}</span>}
          </button>
          {popover === 'filter' && (
            <div className="menu-list filter-panel kanban-filter">
              <div className="kf-cols">
                <div>
                  <div className="filter-title muted-title">Created By</div>
                  {options.creators.map((c) => (
                    <label key={c} className="filter-check">
                      <input type="checkbox" checked={isOn('creators', c)} onChange={() => flip('creators', c, options.creators)} />
                      {c}
                    </label>
                  ))}
                </div>
                <div>
                  <div className="filter-title muted-title">Tag</div>
                  <label className="filter-check">
                    <input type="checkbox" checked={!draft.tags} onChange={(e) => setDraft((d) => ({ ...d, tags: e.target.checked ? null : [] }))} />
                    ALL
                  </label>
                  {options.tags.map((t) => (
                    <label key={t} className="filter-check">
                      <input type="checkbox" checked={isOn('tags', t)} onChange={() => flip('tags', t, options.tags)} />
                      {t}
                    </label>
                  ))}
                </div>
                <div>
                  <div className="filter-title muted-title">Color</div>
                  {options.colors.map((c) => (
                    <label key={c} className="filter-check">
                      <input type="checkbox" checked={isOn('colors', c)} onChange={() => flip('colors', c, options.colors)} />
                      <span className="kf-swatch" style={{ background: c }} />
                    </label>
                  ))}
                </div>
              </div>
              <div className="filter-foot kf-foot">
                <button
                  className="kf-clear"
                  onClick={() => {
                    setDraft(NO_FILTER);
                    setFlt(NO_FILTER);
                    setPopover(null);
                  }}
                >
                  Clear Filter
                </button>
                <button
                  className="btn btn-blue"
                  onClick={() => {
                    setFlt(draft);
                    setPopover(null);
                  }}
                >
                  Apply
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="menu">
          <button className={`icon-btn view-kebab ${showMore ? 'on' : ''}`} aria-label="More options" title="More options" onClick={() => setShowMore((o) => !o)}>
            ⋮
          </button>
          {showMore && (
            <div className="menu-list icon-menu" onMouseLeave={() => setShowMore(false)}>
              {canEdit && (
                <Item
                  icon={Icons.upload}
                  label="Bulk import (CSV)"
                  onClick={() => {
                    setShowMore(false);
                    setDialog({ kind: 'import' });
                  }}
                />
              )}
              <Item
                icon={Icons.download}
                label="Export CSV"
                onClick={() => {
                  setShowMore(false);
                  void exportCsv();
                }}
              />
            </div>
          )}
        </div>
        {canEdit && (
          <Link href="/kanbans/new" className="opt-btn inline">
            + Create New
          </Link>
        )}
      </SubbarRight>

      {selected.size > 0 && (
        <div className="row select-bar">
          <strong>{selected.size} selected</strong>
          <button className="btn btn-sm" onClick={printSelected}>
            Print cards
          </button>
          {canEdit && (
            <button className="btn btn-sm" onClick={() => setDialog({ kind: 'bulk' })}>
              Bulk edit
            </button>
          )}
          <button className="btn btn-sm" onClick={() => setSelected(new Set(items.map((i) => i.id)))}>
            Select all
          </button>
          <button className="btn btn-sm" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {notice && <div className="success">{notice}</div>}

      <div className={`sop-grid kanban-grid${selected.size ? ' selecting' : ''}`}>
        {items.map((k) => {
          const title = kanbanTitle(k);
          return (
            <div
              key={k.id}
              className={`sop-card kanban-card${selected.has(k.id) ? ' selected' : ''}`}
              onClick={() => router.push(`/kanbans/${k.id}`)}
            >
              <div className="kanban-thumb">
                {k.picture ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={k.picture.url}
                    alt={k.partCode}
                    loading="lazy"
                    decoding="async"
                    title="Click to enlarge"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPopup({ url: k.picture!.url, alt: title });
                    }}
                  />
                ) : (
                  <span className="kanban-noimg" />
                )}
                <input
                  type="checkbox"
                  className="kanban-check"
                  aria-label={`Select ${k.partCode}`}
                  checked={selected.has(k.id)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggle(k.id)}
                />
              </div>
              <div className="kanban-info">
                <div className="name" title={title}>
                  {title}
                </div>
                <div className="line">Supplier Part No: <b>{k.supplierPartNo ?? 'N/A'}</b></div>
                <div className="line">Created Date: <b>{fmtListDate(k.createdAt)}</b></div>
                <div className="line">Tag: <b>{k.tag ?? 'NO TAG'}</b></div>
                <div className="line">Created By: <b>{k.createdBy?.name ?? 'N/A'}</b></div>
                <div className="line">Last Modified: <b>{fmtListDate(k.updatedAt)}</b></div>
              </div>
              <KanbanCardMenu
                kanban={k}
                canEdit={canEdit}
                onError={setError}
                onChanged={(msg) => {
                  setNotice(msg ?? null);
                  void load();
                }}
              />
            </div>
          );
        })}
      </div>
      {data && items.length === 0 && <p className="muted">No kanban cards found.</p>}
      {popup && <Lightbox images={[popup]} start={0} onClose={() => setPopup(null)} />}

      {dialog && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          {dialog.kind === 'import' && (
            <ImportDialog
              onClose={(msg) => {
                setDialog(null);
                if (msg) setNotice(msg);
                void load();
              }}
            />
          )}
          {dialog.kind === 'bulk' && (
            <BulkEditDialog
              ids={[...selected]}
              onClose={(msg) => {
                setDialog(null);
                if (msg) setNotice(msg);
                void load();
              }}
            />
          )}
        </div>
      )}
    </>
  );
}

const TEMPLATE_CSV =
  'part_code,part_description,supplier,supplier_part_no,used_for,order_when,order_qty,delivery_time,location,price,carriage,custom_field_1,custom_field_2,ordering_type,ordering_url,ordering_sop_ref,ordering_email,tag,color,barcode,template\n' +
  'BRG-6204,Ball bearing,SKF,6204-2Z,Conveyor rollers,2 left,10,3 days,Rack A3,,,,,url,https://shop.example.com/6204,,,bearings,#b0825e,4006,01\n';

function ImportDialog({ onClose }: { onClose: (msg?: string) => void }) {
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<{ imported: number; valid: number; errors: { row: number; error: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(dryRun: boolean) {
    setError(null);
    try {
      const r = await api<NonNullable<typeof result>>('/kanbans/bulk/import', { method: 'POST', body: { csv, dryRun } });
      setResult(r);
      if (!dryRun && r.imported > 0) onClose(`${r.imported} kanban cards imported.`);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <div className="card dialog" style={{ maxWidth: 680 }} onClick={(e) => e.stopPropagation()}>
      <h3 style={{ marginTop: 0 }}>Bulk import kanbans (CSV)</h3>
      <p className="muted">
        The import is all-or-nothing: nothing is saved unless every row is valid.{' '}
        <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE_CSV)}`} download="kanban-template.csv">
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

function BulkEditDialog({ ids, onClose }: { ids: string[]; onClose: (msg?: string) => void }) {
  const [patch, setPatch] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const fields: [string, string][] = [
    ['tag', 'Tag'],
    ['location', 'Location'],
    ['supplier', 'Supplier'],
    ['orderWhen', 'Order when'],
    ['orderQty', 'Order qty'],
    ['deliveryTime', 'Delivery time'],
  ];
  return (
    <form
      className="card dialog"
      onClick={(e) => e.stopPropagation()}
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          const body = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== ''));
          const r = await api<{ updated: number }>('/kanbans/bulk', { method: 'PATCH', body: { ids, patch: body } });
          onClose(`${r.updated} cards updated.`);
        } catch (err) {
          setError(errorMessage(err));
        }
      }}
    >
      <h3 style={{ marginTop: 0 }}>Bulk edit {ids.length} cards</h3>
      <p className="muted">Only fields you fill in are changed.</p>
      {fields.map(([k, label]) => (
        <div className="field" key={k}>
          <label htmlFor={`b-${k}`}>{label}</label>
          <input id={`b-${k}`} value={patch[k] ?? ''} onChange={(e) => setPatch({ ...patch, [k]: e.target.value })} />
        </div>
      ))}
      <div className="field">
        <label htmlFor="b-template">Template</label>
        <select id="b-template" value={patch.template ?? ''} onChange={(e) => setPatch({ ...patch, template: e.target.value })}>
          <option value="">(unchanged)</option>
          <option value="01">01</option>
          <option value="02">02</option>
        </select>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="row">
        <div className="spacer" />
        <button type="button" className="btn" onClick={() => onClose()}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary">
          Apply
        </button>
      </div>
    </form>
  );
}
