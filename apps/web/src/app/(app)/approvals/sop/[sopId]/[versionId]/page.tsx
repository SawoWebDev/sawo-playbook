'use client';

import { useToast } from '@/components/feedback/Toast';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errorMessage, fmtDate } from '@/lib/format';
import { ActionDialog } from '@/components/approvals/ActionDialog';
import { loadApprovalItems, STATE_LABEL, type SopActions } from '@/components/approvals/model';

interface Decision {
  id: string;
  round: number;
  stage: 'pre' | 'final';
  decision: 'approved' | 'rejected';
  comment: string | null;
  createdAt: string;
  approver: { id: string; name: string };
}

/** The SOP approval response, as the server returns it. Every figure shown is taken from here. */
interface SopApproval {
  versionId: string;
  label: string;
  lifecycleState: string;
  stage: 'pre' | 'final' | null;
  currentApprovalRound: number;
  quorum: {
    required: number;
    current: number;
    remaining: number;
    eligibleApproverCount: number;
    availableApproverCount: number;
    currentUserApproved: boolean;
    currentUserCanApprove: boolean;
    stage: 'pre' | 'final';
  };
  preApprovalSkipped: boolean;
  preApprovalSkippedBy: string | null;
  routingGroups: { id: string; name: string | null }[];
  blocked: boolean;
  blockedReason: string | null;
  actions: SopActions;
  decisions: Decision[];
}

interface SopHeader {
  name: string;
  referenceNo: string;
}

type Dialog = 'preApprove' | 'approve' | 'reject' | 'publish' | null;

const STATUS_CLASS: Record<string, string> = {
  PENDING_PRE_APPROVAL: 'badge-blue',
  PENDING_APPROVAL: 'badge-blue',
  APPROVED: 'badge-green',
  PUBLISHED: 'badge-green',
  DRAFT: 'badge-amber',
};

export default function SopApprovalPage() {
  const { sopId, versionId } = useParams<{ sopId: string; versionId: string }>();
  const [detail, setDetail] = useState<SopApproval | null>(null);
  const [sop, setSop] = useState<SopHeader | null>(null);
  const [submitter, setSubmitter] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);

  const load = useCallback(async () => {
    const [d, header] = await Promise.all([
      api<SopApproval>(`/sops/${sopId}/versions/${versionId}/approvals`),
      api<SopHeader>(`/sops/${sopId}`).catch(() => null),
    ]);
    setDetail(d);
    setSop(header);
    // The submitter's name comes from the inbox the server built for this caller, if this item is in it.
    const mine = (await loadApprovalItems().catch(() => [])).find((i) => i.kind === 'sop' && i.id === versionId);
    setSubmitter(mine?.submitter ?? null);
  }, [sopId, versionId]);

  useEffect(() => {
    load().catch((e) => setError(errorMessage(e)));
  }, [load]);

  /** Runs one server action, then shows the result and reloads the server's view. */
  const act = async (path: string, body: object, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/sops/${sopId}/versions/${versionId}${path}`, { method: 'POST', body });
      toast.success(done);
      setDialog(null);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (error && !detail) {
    return (
      <>
        <p><Link href="/approvals">← Approval Center</Link></p>
        <div className="error" role="alert">{error}</div>
      </>
    );
  }
  if (!detail) return <p className="muted" role="status">Loading approval…</p>;

  const q = detail.quorum;
  const skipper = detail.preApprovalSkippedBy ? detail.decisions.find((d) => d.approver.id === detail.preApprovalSkippedBy)?.approver.name ?? 'an Approver' : null;
  const awaitingPre = detail.lifecycleState === 'PENDING_PRE_APPROVAL';
  const notEnoughApprovers = q.availableApproverCount < q.remaining;
  const stateLabel = STATE_LABEL[detail.lifecycleState] ?? detail.lifecycleState;

  return (
    <>
      <p style={{ marginTop: 0 }}><Link href="/approvals">← Approval Center</Link></p>
      <div className="row" style={{ marginBottom: 6, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>{sop?.name ?? 'STD OPS'}</h1>
        <span className="muted">{sop?.referenceNo} · {detail.label}</span>
        <div className="spacer" />
        <span className={`badge ${STATUS_CLASS[detail.lifecycleState] ?? 'badge-blue'}`}>{stateLabel}</span>
      </div>
      {error && <div className="error" role="alert">{error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
        <section className="card" aria-label="Workflow">
          <h3 style={{ marginTop: 0 }}>Workflow</h3>
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            Draft → Pending pre-approval → Pending final approval → Approved → Published
          </p>
          <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 14px', margin: 0 }}>
            <dt className="muted">Submitted by</dt>
            <dd style={{ margin: 0 }}>{submitter ?? 'Not visible in your queue'}</dd>
            <dt className="muted">Current stage</dt>
            <dd style={{ margin: 0 }}>{detail.stage === 'pre' ? 'Pre-approval' : detail.stage === 'final' ? 'Final approval' : 'None'}</dd>
            <dt className="muted">Routed to</dt>
            <dd style={{ margin: 0 }}>
              {detail.routingGroups.length === 0
                ? 'Organisation-wide (submitted by an Admin)'
                : detail.routingGroups.map((g) => g.name ?? 'Unnamed group').join(', ')}
            </dd>
            <dt className="muted">Round</dt>
            <dd style={{ margin: 0 }}>{detail.currentApprovalRound}</dd>
          </dl>

          {detail.preApprovalSkipped && (
            <div className="success" style={{ marginTop: 12 }}>
              Pre Approval skipped by {skipper}. They cast a final approval vote; the version still needs the full quorum before it is approved.
            </div>
          )}

          {detail.blocked && (
            <div className="error" role="status" style={{ marginTop: 12 }}>
              <strong>Blocked.</strong> {detail.blockedReason}
              <div style={{ marginTop: 6 }}>
                {awaitingPre ? (
                  <>No eligible Pre Approver is available for this group.</>
                ) : (
                  <>
                    {q.availableApproverCount} eligible approver{q.availableApproverCount === 1 ? '' : 's'} available, {q.remaining} more approval{q.remaining === 1 ? '' : 's'} needed.
                  </>
                )}
                {' '}Admins have been notified. It becomes actionable again when an eligible person is available.
              </div>
            </div>
          )}
          {!detail.blocked && notEnoughApprovers && !awaitingPre && (
            <div className="error" role="status" style={{ marginTop: 12 }}>
              Fewer available approvers ({q.availableApproverCount}) than approvals still needed ({q.remaining}).
            </div>
          )}

          <h3 style={{ marginTop: 18 }}>Decisions</h3>
          {detail.decisions.length === 0 ? (
            <p className="muted">No decisions yet.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Round</th>
                  <th>Stage</th>
                  <th>Decision</th>
                  <th>By</th>
                  <th>Comment</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {detail.decisions.map((d) => (
                  <tr key={d.id}>
                    <td>{d.round}</td>
                    <td>{d.stage === 'pre' ? 'Pre-approval' : 'Final'}</td>
                    <td>{d.decision === 'approved' ? 'Approved' : 'Rejected'}</td>
                    <td>{d.approver.name}</td>
                    <td className="muted">{d.comment ?? '—'}</td>
                    <td className="muted">{fmtDate(d.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="card" aria-label="Quorum and your position">
          <h3 style={{ marginTop: 0 }}>Final approval quorum</h3>
          {detail.stage === 'pre' || detail.lifecycleState === 'DRAFT' ? (
            <p className="muted" style={{ marginTop: 0 }}>
              Final approvals start after pre-approval. The quorum needed is {q.required} distinct approvers.
            </p>
          ) : (
            <>
              <div style={{ fontSize: 28, fontWeight: 600 }} aria-label={`${q.current} of ${q.required} approvals`}>
                {q.current} of {q.required} approvals
              </div>
              <div aria-hidden="true" style={{ height: 8, background: 'var(--border)', borderRadius: 4, margin: '8px 0 12px', overflow: 'hidden' }}>
                <div style={{ width: `${Math.min(100, (q.current / Math.max(1, q.required)) * 100)}%`, height: '100%', background: 'var(--primary)' }} />
              </div>
            </>
          )}
          <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 14px', margin: 0 }}>
            <dt className="muted">Required</dt>
            <dd style={{ margin: 0 }}>{q.required}</dd>
            <dt className="muted">Approved</dt>
            <dd style={{ margin: 0 }}>{q.current}</dd>
            <dt className="muted">Remaining</dt>
            <dd style={{ margin: 0 }}>{q.remaining}</dd>
            <dt className="muted">Eligible approvers</dt>
            <dd style={{ margin: 0 }}>{q.eligibleApproverCount}</dd>
            <dt className="muted">Available approvers</dt>
            <dd style={{ margin: 0 }}>{q.availableApproverCount}</dd>
            <dt className="muted">Your approval</dt>
            <dd style={{ margin: 0 }}>{q.currentUserApproved ? 'Approved by you' : 'Not approved by you'}</dd>
            <dt className="muted">You can approve</dt>
            <dd style={{ margin: 0 }}>{q.currentUserCanApprove ? 'Yes' : 'No'}</dd>
          </dl>
        </section>

        <section className="card" aria-label="Actions" style={{ gridColumn: '1 / -1' }}>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {detail.actions.preApprove && (
              <button className="btn btn-primary btn-sm" type="button" disabled={busy} onClick={() => setDialog('preApprove')}>Pre-approve</button>
            )}
            {detail.actions.approve && (
              <button className="btn btn-primary btn-sm" type="button" disabled={busy} onClick={() => setDialog('approve')}>
                {awaitingPre ? 'Approve (skips pre-approval)' : 'Approve'}
              </button>
            )}
            {detail.actions.reject && (
              <button className="btn btn-danger btn-sm" type="button" disabled={busy} onClick={() => setDialog('reject')}>Reject</button>
            )}
            {detail.actions.publish && (
              <button className="btn btn-primary btn-sm" type="button" disabled={busy} onClick={() => setDialog('publish')}>Publish</button>
            )}
            {!detail.actions.preApprove && !detail.actions.approve && !detail.actions.reject && !detail.actions.publish && (
              <span className="muted">No action is available to you on this version right now.</span>
            )}
            <div className="spacer" />
            <Link className="btn btn-sm" href={`/sops/${sopId}`}>Open STD OPS to review the steps</Link>
          </div>
        </section>
      </div>

      {dialog === 'preApprove' && (
        <ActionDialog title="Pre-approve this SOP?" confirmLabel="Pre-approve" busy={busy} onCancel={() => setDialog(null)} onConfirm={() => act('/pre-approve', {}, 'Pre-approved. It moves to final approval.')}>
          It moves to final approval, where {q.required} distinct approvers must approve it before it can be published.
        </ActionDialog>
      )}
      {dialog === 'approve' && (
        <ActionDialog
          title={awaitingPre ? 'Approve, skipping pre-approval?' : 'Record your approval?'}
          confirmLabel="Record approval"
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={() => act('/decisions', { decision: 'approved' }, awaitingPre ? 'Approval recorded. Pre-approval was skipped; the quorum still applies.' : 'Approval recorded.')}
        >
          {awaitingPre
            ? `This records one final approval and skips the pre-approval stage. It does not publish the SOP, and it does not replace the quorum: ${q.required - q.current} more approval${q.required - q.current === 1 ? '' : 's'} are needed after this one.`
            : `This counts as one of the ${q.required} final approvals. The SOP becomes approved once the quorum is reached, and it does not publish by itself.`}
        </ActionDialog>
      )}
      {dialog === 'reject' && (
        <ActionDialog title="Reject this SOP?" confirmLabel="Reject" danger requireComment busy={busy} onCancel={() => setDialog(null)} onConfirm={(comment) => act('/reject', { comment }, 'Rejected. It has returned to draft for the submitter.')}>
          It returns to draft. The submitter sees your reason and can edit and resubmit.
        </ActionDialog>
      )}
      {dialog === 'publish' && (
        <ActionDialog title="Publish this version?" confirmLabel="Publish" busy={busy} onCancel={() => setDialog(null)} onConfirm={() => act('/publish', {}, 'Published. This is now the live version.')}>
          It becomes the live version. The previous live version is kept in history.
        </ActionDialog>
      )}
    </>
  );
}
