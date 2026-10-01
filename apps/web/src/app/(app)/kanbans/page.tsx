'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { KanbanForm, type Kanban } from '@/components/KanbanForm';
import { Lightbox, type LightboxImage } from '@/components/Lightbox';
import { Icons, SubbarLeft, SubbarRight } from '@/components/Subbar';
import { api, apiRaw } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage, fmtDate } from '@/lib/format';
import { allowed } from '@/lib/permissions';
import type { SopListItem } from '@/lib/types';

interface ListResponse {
  total: number;
  facets: { tags: string[]; suppliers: string[]; locations: string[] };
  items: Kanban[];
}

type Dialog = { kind: 'form'; kanban?: Kanban } | { kind: 'import' } | { kind: 'bulk' } | null;

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
  const canEdit = allowed(user?.role, 'editKanbans');
  const [data, setData] = useState<ListResponse | null>(null);
  const [q, setQ] = useState(() => ({
    search: initialSearch,
    tag: '',
    supplier: '',
    location: '',
    sort: 'partCode',
    dir: 'asc',
  }));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<Dialog>(null);
  const [sops, setSops] = useState<SopListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [popup, setPopup] = useState<LightboxImage | null>(null);
  const [createMenu, setCreateMenu] = useState(false);
  const [cardMenu, setCardMenu] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [showSort, setShowSort] = useState(false);

  const load = useCallback(async () => {
    const p = new URLSearchParams({ limit: '500' });
    Object.entries(q).forEach(([k, v]) => v && p.set(k, v));
    try {
      setData(await api<ListResponse>(`/kanbans?${p}`));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [q]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    if (canEdit) api<{ items: SopListItem[] }>('/sops?limit=200').then((r) => setSops(r.items)).catch(() => undefined);
  }, [canEdit]);

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

  const setField = (k: keyof typeof q) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setQ({ ...q, [k]: e.target.value });

  async function remove(k: Kanban) {
    if (!confirm(`Delete ${k.partCode}?`)) return;
    try {
      await api(`/kanbans/${k.id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const orderLink = (k: Kanban) =>
    k.orderingType === 'url' && k.orderingUrl
      ? { href: k.orderingUrl, label: 'Order online', external: true }
      : k.orderingType === 'email' && k.orderingEmail
        ? { href: `mailto:${k.orderingEmail}?subject=${encodeURIComponent(`Order ${k.partCode}`)}`, label: 'Email order', external: false }
        : k.orderingType === 'sop' && k.orderingSop
          ? { href: `/sops/${k.orderingSop.id}`, label: 'Ordering SOP', external: false }
          : null;

  return (
    <>
      <SubbarLeft>
        {canEdit && (
          <div className="menu">
            <button className="btn btn-orange" onClick={() => setCreateMenu((o) => !o)}>
              + Create New
            </button>
            {createMenu && (
              <div className="menu-list" style={{ left: 0, right: 'auto' }} onMouseLeave={() => setCreateMenu(false)}>
                <button
                  onClick={() => {
                    setCreateMenu(false);
                    setDialog({ kind: 'form' });
                  }}
                >
                  New card
                </button>
                <button
                  onClick={() => {
                    setCreateMenu(false);
                    setDialog({ kind: 'import' });
                  }}
                >
                  Bulk import (CSV)
                </button>
                <button
                  onClick={() => {
                    setCreateMenu(false);
                    void exportCsv();
                  }}
                >
                  Export CSV
                </button>
              </div>
            )}
          </div>
        )}
      </SubbarLeft>
      <SubbarRight>
        <button className={`icon-btn ${showFilters ? 'on' : ''}`} aria-label="Filter" title="Filter" onClick={() => setShowFilters((o) => !o)}>
          {Icons.filter}
        </button>
        <button className={`icon-btn ${showSort ? 'on' : ''}`} aria-label="Sort" title="Sort" onClick={() => setShowSort((o) => !o)}>
          {Icons.sort}
        </button>
      </SubbarRight>

      <div className="row" style={{ marginBottom: 8 }}>
        <input placeholder="Search part, supplier, tag…" value={q.search} onChange={setField('search')} style={{ width: 260 }} />
        {showFilters && (
          <>
            <select value={q.tag} onChange={setField('tag')} style={{ width: 160 }}>
              <option value="">All tags</option>
              {data?.facets.tags.map((t) => <option key={t}>{t}</option>)}
            </select>
            <select value={q.supplier} onChange={setField('supplier')} style={{ width: 160 }}>
              <option value="">All suppliers</option>
              {data?.facets.suppliers.map((t) => <option key={t}>{t}</option>)}
            </select>
            <select value={q.location} onChange={setField('location')} style={{ width: 160 }}>
              <option value="">All locations</option>
              {data?.facets.locations.map((t) => <option key={t}>{t}</option>)}
            </select>
          </>
        )}
        {showSort && (
          <>
            <select value={q.sort} onChange={setField('sort')} style={{ width: 170 }}>
              <option value="partCode">Sort: part code</option>
              <option value="partDescription">Sort: description</option>
              <option value="supplier">Sort: supplier</option>
              <option value="location">Sort: location</option>
              <option value="updatedAt">Sort: last modified</option>
            </select>
            <select value={q.dir} onChange={setField('dir')} style={{ width: 100 }}>
              <option value="asc">↑ asc</option>
              <option value="desc">↓ desc</option>
            </select>
          </>
        )}
      </div>

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
          <button className="btn btn-sm" onClick={() => setSelected(new Set(data?.items.map((i) => i.id)))}>
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
        {data?.items.map((k) => {
          const order = orderLink(k);
          const title = k.partDescription ? `[${k.partCode}] ${k.partDescription}` : k.partCode;
          return (
            <div
              key={k.id}
              className={`sop-card kanban-card${selected.has(k.id) ? ' selected' : ''}`}
              style={{ borderLeftColor: k.color || 'var(--wood-grad)' }}
              onClick={() => canEdit && setDialog({ kind: 'form', kanban: k })}
            >
              <div className="kanban-thumb">
                {k.picture ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={k.picture.url}
                    alt={k.partCode}
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
                <div className="line">Created Date: <b>{fmtDate(k.createdAt)}</b></div>
                <div className="line">Tag: <b>{k.tag ?? 'NO TAG'}</b></div>
                <div className="line">Created By: <b>{k.createdBy?.name ?? 'N/A'}</b></div>
                <div className="line">Last Modified: <b>{fmtDate(k.updatedAt)}</b></div>
              </div>
              <div className="menu kanban-more" onClick={(e) => e.stopPropagation()}>
                <button className="more" aria-label={`Actions for ${k.partCode}`} onClick={() => setCardMenu((m) => (m === k.id ? null : k.id))}>
                  •••
                </button>
                {cardMenu === k.id && (
                  <div className="menu-list" onMouseLeave={() => setCardMenu(null)}>
                    {canEdit && <button onClick={() => { setCardMenu(null); setDialog({ kind: 'form', kanban: k }); }}>Edit</button>}
                    <button onClick={() => { setCardMenu(null); toggle(k.id); }}>{selected.has(k.id) ? 'Deselect' : 'Select'}</button>
                    {order && (
                      <a href={order.href} {...(order.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
                        {order.label}
                      </a>
                    )}
                    {canEdit && (
                      <button className="danger" onClick={() => { setCardMenu(null); void remove(k); }}>
                        Delete
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {data && data.items.length === 0 && <p className="muted">No kanban cards found.</p>}
      {popup && <Lightbox images={[popup]} start={0} onClose={() => setPopup(null)} />}

      {dialog && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          {dialog.kind === 'form' && (
            <KanbanForm
              kanban={dialog.kanban}
              sops={sops}
              onCancel={() => setDialog(null)}
              onDone={() => {
                setDialog(null);
                void load();
              }}
            />
          )}
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
