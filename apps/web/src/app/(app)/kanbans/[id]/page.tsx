'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ChangeHistory } from '@/components/KanbanCardMenu';
import type { Kanban } from '@/components/KanbanForm';
import { Lightbox } from '@/components/Lightbox';
import { Item } from '@/components/SopCardMenu';
import { Icons, SubbarLeft, SubbarRight } from '@/components/Subbar';
import { api, apiRaw } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage, fmtListDate } from '@/lib/format';
import { kanbanDescription, kanbanTitle } from '@/lib/kanban';
import { allowed } from '@/lib/permissions';

const money = (n: number | null) => (n === null || n === undefined ? null : n.toFixed(2));

export default function KanbanDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const [k, setK] = useState<Kanban | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [history, setHistory] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Kanban>(`/kanbans/${id}`)
      .then(setK)
      .catch((e) => setError(errorMessage(e)));
  }, [id]);

  if (error && !k) return <div className="error">{error}</div>;
  if (!k) return <p className="muted">Loading…</p>;

  const canEdit = allowed(user?.role, 'editKanbans');
  const title = kanbanTitle(k);

  async function printPdf(share = false) {
    setBusy(true);
    setError(null);
    try {
      const res = await apiRaw('/kanbans/bulk/print', { method: 'POST', body: { ids: [id] } });
      if (!res.ok) throw new Error(`Print failed (${res.status})`);
      const blob = await res.blob();
      const file = new File([blob], `${k!.partCode}.pdf`, { type: 'application/pdf' });
      if (share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: kanbanTitle(k!) }).catch(() => undefined);
      } else {
        const url = URL.createObjectURL(blob);
        if (share) {
          const a = document.createElement('a');
          a.href = url;
          a.download = file.name;
          a.click();
        } else window.open(url, '_blank', 'noopener');
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete kanban card ${k!.partCode}?`)) return;
    try {
      await api(`/kanbans/${id}`, { method: 'DELETE' });
      router.replace('/kanbans');
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const ordering =
    k.orderingType === 'sop' ? k.orderingSop && `${k.orderingSop.referenceNo} · ${k.orderingSop.name}` : k.orderingType === 'email' ? k.orderingEmail : k.orderingUrl;
  const fields: [string, string | null | undefined][] = [
    ['Part Description', kanbanDescription(k) || null],
    ['Supplier', k.supplier],
    ['Supplier Part Number', k.supplierPartNo],
    ['Used For', k.usedFor],
    ['Order When', k.orderWhen],
    ['Order Qty', k.orderQty],
    ['Delivery Time', k.deliveryTime],
    ['Location', k.location],
    ['Price', money(k.price)],
    ['Carriage', money(k.carriage)],
    ['Custom Field 1', k.customField1],
    ['Custom Field 2', k.customField2],
    ['Barcode Number (Code 128)', k.barcode],
    ['Tag', k.tag],
    ['Kanban Type', k.template],
    ['Ordering', ordering],
  ];

  return (
    <>
      <SubbarLeft>
        <Link href="/kanbans" className="back-btn">
          <span className="back-chev">‹</span> Back
        </Link>
        <strong className="bar-title">{title}</strong>
      </SubbarLeft>
      <SubbarRight>
        {canEdit && (
          <Link className="btn btn-blue" href={`/kanbans/${id}/edit`}>
            {Icons.pencil} Edit
          </Link>
        )}
        <div className="menu">
          <button className="kebab" aria-label="More options" aria-expanded={more} onClick={() => setMore((o) => !o)}>
            ⋮
          </button>
          {more && (
            <div className="menu-list more-menu icon-menu" onMouseLeave={() => setMore(false)}>
              {canEdit && <Item icon={Icons.copy} label="Duplicate" onClick={() => router.push(`/kanbans/new?copy=${id}`)} />}
              <Item
                icon={Icons.history}
                label="Change History"
                onClick={() => {
                  setMore(false);
                  setHistory(true);
                }}
              />
              <div className="more-title">Details</div>
              <dl className="kv more-kv">
                <dt>Created date</dt>
                <dd>{fmtListDate(k.createdAt)}</dd>
                <dt>Created by</dt>
                <dd>{k.createdBy?.name ?? '—'}</dd>
                <dt>Last modified</dt>
                <dd>{fmtListDate(k.updatedAt)}</dd>
              </dl>
              {canEdit && <Item icon={Icons.trash} label="Delete" danger onClick={() => void remove()} />}
            </div>
          )}
        </div>
      </SubbarRight>

      {history && <ChangeHistory kanban={k} onClose={() => setHistory(false)} />}
      {zoom && k.picture && <Lightbox images={[{ url: k.picture.url, alt: title }]} start={0} onClose={() => setZoom(false)} />}

      <div className="layout-2 kanban-detail">
        <aside className="panel">
          {k.picture && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={k.picture.url} alt={k.partCode} title="Click to enlarge" onClick={() => setZoom(true)} style={{ width: '100%', borderRadius: 6, cursor: 'zoom-in', border: '1px solid #e4e4e4' }} />
          )}
          <div className="opt-card">
            <div className="opt-head">View or Print Options</div>
            <div className="opt-body">
              <button className="opt-btn outline" disabled={busy} onClick={() => void printPdf(true)}>
                Share PDF
              </button>
              <button className="opt-btn outline" disabled={busy} onClick={() => void printPdf()}>
                View or Print PDF
              </button>
            </div>
          </div>
          <button className="regen" onClick={() => window.location.reload()}>
            Issue with PDF? Click to regenerate
          </button>
        </aside>
        <div>
          {error && <div className="error">{error}</div>}
          <div className="info-card">
            <div>
              <div className="info-label">Part Number</div>
              <div className="info-value">{k.partCode}</div>
            </div>
            <div>
              <div className="info-label">Created By</div>
              <div className="info-value">{k.createdBy?.name ?? 'N/A'}</div>
            </div>
            <div>
              <div className="info-label">Created Date</div>
              <div className="info-value">{fmtListDate(k.createdAt)}</div>
            </div>
            <div>
              <div className="info-label">Last Modified</div>
              <div className="info-value">{fmtListDate(k.updatedAt)}</div>
            </div>
          </div>
          <div className="info-card">
            {fields.map(([label, value]) => (
              <div key={label}>
                <div className="info-label">{label}</div>
                <div className="info-value">{value || 'N/A'}</div>
              </div>
            ))}
          </div>
        </div>

      </div>
    </>
  );
}
