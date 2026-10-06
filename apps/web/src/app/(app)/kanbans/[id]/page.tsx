'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ChangeHistory } from '@/components/KanbanCardMenu';
import type { Kanban } from '@/components/KanbanForm';
import { Lightbox } from '@/components/Lightbox';
import { KanbanRevisionBadge } from '@/components/StatusBadge';
import { Item } from '@/components/SopCardMenu';
import { Icons, SubbarLeft, SubbarRight } from '@/components/Subbar';
import { api, apiRaw } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage, fmtListDate } from '@/lib/format';
import { blockedReasons, fetchKanbanInbox, isLockedForEdit, kanbanDescription, kanbanTitle } from '@/lib/kanban';
import { hasPermission } from '@/lib/permissions';
import type { KanbanRevisionActions, KanbanRevisionDetail, KanbanRevisionState } from '@/lib/types';

const money = (n: number | null) => (n === null || n === undefined ? null : n.toFixed(2));

const NO_ACTIONS: KanbanRevisionActions = { submit: false, preApprove: false, approve: false, reject: false, publish: false };

/** The step the open revision is waiting on, by the API's state. Pre-approval and approval are separate stages. */
function waitingOn(state: KanbanRevisionState): string {
  switch (state) {
    case 'DRAFT':
      return 'Submission';
    case 'PENDING_PRE_APPROVAL':
      return 'Pre Approval';
    case 'PRE_APPROVED':
      return 'Approval';
    case 'APPROVED':
      return 'Publishing';
    default:
      return '—';
  }
}

export default function KanbanDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const [k, setK] = useState<Kanban | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [revision, setRevision] = useState<KanbanRevisionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rejectComment, setRejectComment] = useState('');
  const [more, setMore] = useState(false);
  const [history, setHistory] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [busy, setBusy] = useState(false);

  /**
   * The card says whether a revision is open (openRevision). The revision says what this user may do with it. A viewer
   * who cannot see the revision gets a 404, so the card then shows the review state with no actions.
   */
  const load = useCallback(async () => {
    try {
      const [card, inbox] = await Promise.all([api<Kanban>(`/kanbans/${id}`), fetchKanbanInbox().catch(() => null)]);
      setK(card);
      setBlocked(blockedReasons(inbox).get(id) ?? null);
      setRevision(card.openRevision ? await api<KanbanRevisionDetail>(`/kanbans/revisions/${card.openRevision.id}`).catch(() => null) : null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(ok);
      setRejectComment('');
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (error && !k) return <div className="error">{error}</div>;
  if (!k) return <p className="muted">Loading…</p>;

  const canEdit = hasPermission(user, 'kanban.edit');
  const rev = k.openRevision ?? null;
  const revId = rev?.id;
  const editLocked = !!rev && isLockedForEdit(rev.state);
  const actions = revision?.actions ?? NO_ACTIONS;
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
        {canEdit &&
          (editLocked ? (
            <button className="btn btn-blue" disabled title="This card has a revision in review. Its draft can be edited again once the review is resolved.">
              {Icons.pencil} Edit
            </button>
          ) : (
            <Link className="btn btn-blue" href={`/kanbans/${id}/edit`}>
              {Icons.pencil} Edit
            </Link>
          ))}
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
          {notice && <div className="success">{notice}</div>}
          <div className="info-card">
            <div style={{ gridColumn: '1 / -1' }}>
              <div className="info-label">Approval status</div>
              <div className="info-value">
                {rev ? (
                  <KanbanRevisionBadge state={rev.state} rejected={rev.state === 'DRAFT' && !!rev.comment} blocked={!!blocked} />
                ) : (
                  <span className="badge badge-green">Published</span>
                )}
              </div>
            </div>
            {rev && (
              <>
                <div>
                  <div className="info-label">Submitted By</div>
                  <div className="info-value">{rev.submitter?.name ?? '—'}</div>
                </div>
                <div>
                  <div className="info-label">Submitted</div>
                  <div className="info-value">{revision?.submittedAt ? fmtListDate(revision.submittedAt) : '—'}</div>
                </div>
                <div>
                  <div className="info-label">Routed To</div>
                  <div className="info-value">
                    {revision?.routingGroups.length === 0
                      ? 'Organisation-wide'
                      : revision?.routingGroups.map((g) => g.name ?? '—').join(', ') || '—'}
                  </div>
                </div>
                <div>
                  <div className="info-label">Waiting On</div>
                  <div className="info-value">{waitingOn(rev.state)}</div>
                </div>
                {blocked && (
                  <div style={{ gridColumn: '1 / -1' }}>
                    <div className="info-label">Blocked</div>
                    <div className="info-value">{blocked}</div>
                  </div>
                )}
                {rev.state === 'DRAFT' && rev.comment && (
                  <div style={{ gridColumn: '1 / -1' }}>
                    <div className="info-label">Rejected — reason</div>
                    <div className="info-value" style={{ color: '#b42318' }}>
                      {rev.comment}
                    </div>
                  </div>
                )}
                {rev.state === 'PENDING_PRE_APPROVAL' && actions.approve && (
                  <div style={{ gridColumn: '1 / -1' }} className="muted">
                    You can approve now. Approving skips Pre Approval and counts as the final approval.
                  </div>
                )}
                <div style={{ gridColumn: '1 / -1', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                  {actions.submit && (
                    <button className="btn btn-primary" disabled={busy} onClick={() => act(() => api(`/kanbans/revisions/${revId}/submit`, { method: 'POST', body: {} }), 'Submitted for review.')}>
                      Submit for review
                    </button>
                  )}
                  {actions.preApprove && (
                    <button className="btn btn-primary" disabled={busy} onClick={() => act(() => api(`/kanbans/revisions/${revId}/pre-approve`, { method: 'POST' }), 'Pre-approved.')}>
                      Pre-approve
                    </button>
                  )}
                  {actions.approve && (
                    <button className="btn btn-primary" disabled={busy} onClick={() => act(() => api(`/kanbans/revisions/${revId}/approve`, { method: 'POST' }), 'Approved.')}>
                      Approve
                    </button>
                  )}
                  {actions.publish && (
                    <button className="btn btn-primary" disabled={busy} onClick={() => act(() => api(`/kanbans/revisions/${revId}/publish`, { method: 'POST' }), 'Published. The card is now live.')}>
                      Publish
                    </button>
                  )}
                </div>
                {actions.reject && (
                  <div style={{ gridColumn: '1 / -1', display: 'grid', gap: 8 }}>
                    <textarea placeholder="Reason for rejection (required)" value={rejectComment} onChange={(e) => setRejectComment(e.target.value)} rows={2} />
                    <div>
                      <button
                        className="btn btn-danger"
                        disabled={busy || !rejectComment.trim()}
                        onClick={() => act(() => api(`/kanbans/revisions/${revId}/reject`, { method: 'POST', body: { comment: rejectComment.trim() } }), 'Returned to the editor as a draft.')}
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
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
