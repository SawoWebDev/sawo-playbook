'use client';

import { useToast } from '@/components/feedback/Toast';
import { Loading } from '@/components/feedback/Loading';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errorMessage, fmtDate } from '@/lib/format';
import { ActionDialog } from '@/components/approvals/ActionDialog';
import { loadApprovalItems, STATE_LABEL, type ApprovalItem } from '@/components/approvals/model';
import type { KanbanRevisionActions } from '@/lib/types';

/** The Kanban revision as the server returns it (GET /kanbans/revisions/:id). Kanban has no quorum, so none is shown. */
interface Revision {
  id: string;
  kanbanId: string | null;
  state: string;
  partCode: string;
  partDescription: string | null;
  supplier: string | null;
  location: string | null;
  routingGroups: { id: string; name: string | null }[];
  submittedAt: string | null;
  lastComment: string | null;
  createdBy: { id: string; name: string } | null;
  actions: KanbanRevisionActions;
}

type Dialog = 'preApprove' | 'approve' | 'reject' | 'publish' | null;

export default function KanbanApprovalPage() {
  const { id } = useParams<{ id: string }>();
  const [rev, setRev] = useState<Revision | null>(null);
  const [item, setItem] = useState<ApprovalItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);

  const load = useCallback(async () => {
    const [r, items] = await Promise.all([api<Revision>(`/kanbans/revisions/${id}`), loadApprovalItems()]);
    setRev(r);
    // The actions are the server's own; the inbox item is read only for the blocked reason and the submitter's name.
    setItem(items.find((i) => i.kind === 'kanban' && i.id === id) ?? null);
  }, [id]);

  useEffect(() => {
    load().catch((e) => setError(errorMessage(e)));
  }, [load]);

  const act = async (path: string, body: object, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/kanbans/revisions/${id}${path}`, { method: 'POST', body });
      toast.success(done);
      setDialog(null);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (error && !rev) {
    return (
      <>
        <p><Link href="/approvals">← Approval Center</Link></p>
        <div className="error" role="alert">{error}</div>
      </>
    );
  }
  if (!rev) return <Loading />;

  const { actions } = rev;
  const blocked = !!item?.sections.has('blocked');
  const bypass = actions.approve && rev.state === 'PENDING_PRE_APPROVAL';

  return (
    <>
      <p style={{ marginTop: 0 }}><Link href="/approvals">← Approval Center</Link></p>
      <div className="row" style={{ marginBottom: 6, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>{rev.partCode}</h1>
        <span className="muted">Kanban change{rev.partDescription ? ` · ${rev.partDescription}` : ''}</span>
        <div className="spacer" />
        <span className="badge badge-blue">{STATE_LABEL[rev.state] ?? rev.state}</span>
      </div>
      {error && <div className="error" role="alert">{error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
        <section className="card" aria-label="Change">
          <h3 style={{ marginTop: 0 }}>Proposed change</h3>
          <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 14px', margin: 0 }}>
            <dt className="muted">Submitted by</dt>
            <dd style={{ margin: 0 }}>{rev.createdBy?.name ?? (item?.submitter ?? 'Not visible in your queue')}</dd>
            <dt className="muted">Submitted</dt>
            <dd style={{ margin: 0 }}>{rev.submittedAt ? fmtDate(rev.submittedAt) : '—'}</dd>
            <dt className="muted">Routed to</dt>
            <dd style={{ margin: 0 }}>
              {rev.routingGroups.length === 0 ? 'Organisation-wide (submitted by an Admin)' : rev.routingGroups.map((g) => g.name ?? 'Unnamed group').join(', ')}
            </dd>
            <dt className="muted">Supplier</dt>
            <dd style={{ margin: 0 }}>{rev.supplier ?? '—'}</dd>
            <dt className="muted">Location</dt>
            <dd style={{ margin: 0 }}>{rev.location ?? '—'}</dd>
          </dl>
          {rev.lastComment && (
            <div className="muted" style={{ marginTop: 12 }}>Last reason: {rev.lastComment}</div>
          )}
          {rev.kanbanId && (
            <p style={{ marginTop: 12 }}>
              <Link href={`/kanbans/${rev.kanbanId}`}>Open the live card</Link>
            </p>
          )}
        </section>

        <section className="card" aria-label="Status">
          <h3 style={{ marginTop: 0 }}>Where this stands</h3>
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            Draft → Pending pre-approval → Pre-approved → Approved → Published. A single approval is enough for a Kanban change.
          </p>
          {blocked && item?.blockedReason && (
            <div className="error" role="status">
              <strong>Blocked.</strong> {item.blockedReason}
            </div>
          )}
          {bypass && (
            <div className="success" style={{ marginTop: 10 }}>
              This approval skips pre-approval. It approves the change directly.
            </div>
          )}
        </section>

        <section className="card" aria-label="Actions" style={{ gridColumn: '1 / -1' }}>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {actions.preApprove && (
              <button className="btn btn-primary btn-sm" type="button" disabled={busy} onClick={() => setDialog('preApprove')}>Pre-approve</button>
            )}
            {actions.approve && (
              <button className="btn btn-primary btn-sm" type="button" disabled={busy} onClick={() => setDialog('approve')}>
                {bypass ? 'Approve (skips pre-approval)' : 'Approve'}
              </button>
            )}
            {actions.publish && (
              <button className="btn btn-primary btn-sm" type="button" disabled={busy} onClick={() => setDialog('publish')}>Publish</button>
            )}
            {actions.reject && (
              <button className="btn btn-danger btn-sm" type="button" disabled={busy} onClick={() => setDialog('reject')}>Reject</button>
            )}
            {!actions.preApprove && !actions.approve && !actions.publish && !actions.reject && (
              <span className="muted">No action is available to you on this change right now.</span>
            )}
          </div>
        </section>
      </div>

      {dialog === 'preApprove' && (
        <ActionDialog title="Pre-approve this change?" confirmLabel="Pre-approve" busy={busy} onCancel={() => setDialog(null)} onConfirm={() => act('/pre-approve', {}, 'Pre-approved. It is awaiting approval.')}>
          It moves on to approval. It does not publish the change.
        </ActionDialog>
      )}
      {dialog === 'approve' && (
        <ActionDialog title={bypass ? 'Approve, skipping pre-approval?' : 'Approve this change?'} confirmLabel="Approve" busy={busy} onCancel={() => setDialog(null)} onConfirm={() => act('/approve', {}, 'Approved. It is ready to publish.')}>
          {bypass ? 'This approves the change without a pre-approval. It does not publish it.' : 'The change becomes ready to publish. It does not publish by itself.'}
        </ActionDialog>
      )}
      {dialog === 'reject' && (
        <ActionDialog title="Reject this change?" confirmLabel="Reject" danger requireComment busy={busy} onCancel={() => setDialog(null)} onConfirm={(comment) => act('/reject', { comment }, 'Rejected. It has returned to draft for the submitter.')}>
          It returns to draft. The submitter sees your reason and can edit and resubmit. The live card is not changed.
        </ActionDialog>
      )}
      {dialog === 'publish' && (
        <ActionDialog title="Publish this change?" confirmLabel="Publish" busy={busy} onCancel={() => setDialog(null)} onConfirm={() => act('/publish', {}, 'Published. The live card has been updated.')}>
          The live card is updated with these details.
        </ActionDialog>
      )}
    </>
  );
}
