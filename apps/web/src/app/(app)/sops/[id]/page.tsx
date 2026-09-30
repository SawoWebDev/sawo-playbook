'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { SopStatusBadge, VersionStateBadge } from '@/components/StatusBadge';
import { StepsView } from '@/components/StepsView';
import { api, apiRaw } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage, fmtDate, fmtDateTime, fmtDuration, plural } from '@/lib/format';
import { allowed } from '@/lib/permissions';
import type { ApprovalHistory, SopDetail, VersionDetail } from '@/lib/types';

export default function SopDetailPage() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <SopDetailView />
    </Suspense>
  );
}

function SopDetailView() {
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const { user } = useAuth();
  const [sop, setSop] = useState<SopDetail | null>(null);
  const [version, setVersion] = useState<VersionDetail | null>(null);
  const [approvals, setApprovals] = useState<ApprovalHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  const selected = search.get('v');

  const load = useCallback(async () => {
    try {
      const s = await api<SopDetail>(`/sops/${id}`);
      setSop(s);
      const vid = selected ?? s.activeVersionId ?? s.currentPublishedVersionId ?? s.versions[0]?.id;
      if (vid) {
        const [v, ap] = await Promise.all([
          api<VersionDetail>(`/sops/${id}/versions/${vid}`),
          api<ApprovalHistory>(`/sops/${id}/versions/${vid}/approvals`),
        ]);
        setVersion(v);
        setApprovals(ap);
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [id, selected]);

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
      setComment('');
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function openPdf() {
    if (!version) return;
    setBusy(true);
    try {
      const res = await apiRaw(`/sops/${id}/versions/${version.id}/pdf`);
      if (!res.ok) throw new Error(`PDF export failed (${res.status})`);
      const url = URL.createObjectURL(await res.blob());
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (error && !sop) return <div className="error">{error}</div>;
  if (!sop) return <p className="muted">Loading…</p>;

  const role = user?.role;
  const canEdit = allowed(role, 'editSops') && !sop.archivedAt;
  const canApprove = allowed(role, 'approveSops');
  const canPublish = allowed(role, 'publishSops');
  const v = version;
  const vUrl = v ? `/sops/${id}/versions/${v.id}` : '';
  const isSubmitter = !!v && approvals?.submittedById === user?.id;
  const alreadyVoted =
    !!approvals && approvals.decisions.some((d) => d.round === approvals.currentApprovalRound && d.approver.id === user?.id);
  const lastRejection =
    v?.lifecycleState === 'DRAFT' ? approvals?.decisions.find((d) => d.decision === 'rejected' && d.round === approvals.currentApprovalRound) : undefined;
  const qrLink = typeof window !== 'undefined' ? `${window.location.origin}/s/${sop.qrPublicToken}` : '';

  return (
    <>
      <div className="row" style={{ marginBottom: 4 }}>
        <Link href="/sops" className="muted">
          ← STD OPS
        </Link>
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        <div>
          <div className="muted" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
            {sop.referenceNo} · {sop.type === 'advanced' ? 'Advanced SOP' : 'Standard SOP'}
          </div>
          <h1 style={{ margin: 0 }}>{sop.name}</h1>
        </div>
        <div className="spacer" />
        <SopStatusBadge status={sop.status} approvals={approvals?.approvedInCurrentRound} quorum={approvals?.quorum} />
      </div>

      {error && <div className="error">{error}</div>}
      {notice && <div className="success">{notice}</div>}
      {lastRejection && (
        <div className="card" style={{ borderColor: '#f1c4c0', marginBottom: 12 }}>
          <span className="badge badge-red">Rejected</span> by {lastRejection.approver.name}: {lastRejection.comment}
        </div>
      )}

      <div className="layout-2">
        <div>
          {v && (
            <>
              <div className="row" style={{ marginBottom: 12 }}>
                <strong>Version {v.label}</strong>
                <VersionStateBadge state={v.lifecycleState} />
                <span className="badge">{plural(v.steps.length, 'step')}</span>
                <span className="badge">Cycle time {fmtDuration(v.cycleTimeSeconds)}</span>
                {v.publishedAt && <span className="muted">Published {fmtDate(v.publishedAt)}{v.publishedBy ? ` by ${v.publishedBy.name}` : ''}</span>}
              </div>
              {v.changeSummary && <p className="muted">Changes: {v.changeSummary}</p>}
              <StepsView steps={v.steps} showTitles={sop.type === 'advanced'} />
            </>
          )}
        </div>

        <aside className="panel">
          {v && (
            <div className="card">
              <h3>Actions</h3>
              <div className="panel">
                {canEdit && v.lifecycleState === 'DRAFT' && (
                  <Link className="btn btn-primary" href={`/sops/${id}/edit/${v.id}`}>
                    Edit draft
                  </Link>
                )}
                {canEdit && v.lifecycleState === 'PUBLISHED' && !sop.activeVersionId && (
                  <button
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() =>
                      act(async () => {
                        const nv = await api<VersionDetail>(`/sops/${id}/versions`, { method: 'POST' });
                        router.push(`/sops/${id}/edit/${nv.id}`);
                      }, 'New draft version created.')
                    }
                  >
                    Edit (new version)
                  </button>
                )}
                {canEdit && sop.activeVersionId && v.id !== sop.activeVersionId && (
                  <Link className="btn" href={`/sops/${id}?v=${sop.activeVersionId}`}>
                    Go to version in progress
                  </Link>
                )}
                {allowed(role, 'editSops') && v.lifecycleState === 'DRAFT' && (
                  <button className="btn" disabled={busy || v.steps.length === 0} onClick={() => act(() => api(`${vUrl}/submit`, { method: 'POST', body: {} }), 'Submitted for approval.')}>
                    Submit for approval
                  </button>
                )}
                {canApprove && v.lifecycleState === 'PENDING_APPROVAL' && (
                  <>
                    {isSubmitter && !approvals?.allowSelfApproval ? (
                      <p className="muted">You submitted this version, so you cannot approve it.</p>
                    ) : alreadyVoted ? (
                      <p className="muted">You have already recorded your decision for this round.</p>
                    ) : (
                      <>
                        <textarea placeholder="Comment (required to reject)" value={comment} onChange={(e) => setComment(e.target.value)} rows={2} />
                        <div className="row">
                          <button className="btn btn-primary" disabled={busy} onClick={() => act(() => api(`${vUrl}/decisions`, { method: 'POST', body: { decision: 'approved', comment } }), 'Approval recorded.')}>
                            Approve
                          </button>
                          <button className="btn btn-danger" disabled={busy || !comment.trim()} onClick={() => act(() => api(`${vUrl}/decisions`, { method: 'POST', body: { decision: 'rejected', comment } }), 'Version rejected and returned to draft.')}>
                            Reject
                          </button>
                        </div>
                      </>
                    )}
                  </>
                )}
                {canPublish && v.lifecycleState === 'APPROVED' && (
                  <button className="btn btn-primary" disabled={busy} onClick={() => act(() => api(`${vUrl}/publish`, { method: 'POST' }), 'Version published.')}>
                    Publish
                  </button>
                )}
                {allowed(role, 'editSops') && ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(v.lifecycleState) && (
                  <button
                    className="btn btn-danger"
                    disabled={busy}
                    onClick={() => {
                      if (confirm('Discard this version? This cannot be undone.')) {
                        void act(() => api(`${vUrl}/abandon`, { method: 'POST' }).then(() => router.replace(`/sops/${id}`)), 'Version discarded.');
                      }
                    }}
                  >
                    Discard version
                  </button>
                )}
                {v.lifecycleState === 'PUBLISHED' && v.id === sop.currentPublishedVersionId && v.config.checklist_sop && (
                  <button
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() =>
                      act(async () => {
                        const c = await api<{ id: string }>('/checklists', { method: 'POST', body: { sopId: id } });
                        router.push(`/checklists/${c.id}`);
                      }, 'Checklist started.')
                    }
                  >
                    Start checklist
                  </button>
                )}
                <button className="btn" disabled={busy} onClick={openPdf}>
                  View / Print PDF
                </button>
              </div>
            </div>
          )}

          {approvals && approvals.decisions.length + (v?.lifecycleState === 'PENDING_APPROVAL' ? 1 : 0) > 0 && (
            <div className="card">
              <h3>Approvals</h3>
              {v?.lifecycleState === 'PENDING_APPROVAL' && (
                <p>
                  <strong>
                    {approvals.approvedInCurrentRound}/{approvals.quorum}
                  </strong>{' '}
                  approved (round {approvals.currentApprovalRound})
                </p>
              )}
              <ul style={{ paddingLeft: 18, margin: 0 }}>
                {approvals.decisions.map((d) => (
                  <li key={d.id} style={{ marginBottom: 6 }}>
                    <span className={`badge ${d.decision === 'approved' ? 'badge-green' : 'badge-red'}`}>{d.decision}</span> {d.approver.name}{' '}
                    <span className="muted">
                      · round {d.round} · {fmtDateTime(d.createdAt)}
                    </span>
                    {d.comment && <div className="muted">“{d.comment}”</div>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="card">
            <h3>Share</h3>
            {sop.currentPublishedVersionId ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/qr/${sop.qrPublicToken}/image.png`} alt="QR code" style={{ width: 160, height: 160 }} />
                <p className="muted" style={{ fontSize: 12, wordBreak: 'break-all' }}>
                  The QR always opens the current published version.
                  <br />
                  {qrLink}
                </p>
                <div className="row">
                  <button className="btn btn-sm" onClick={() => navigator.clipboard?.writeText(qrLink).then(() => setNotice('Link copied.'))}>
                    Copy link
                  </button>
                  <a className="btn btn-sm" href={`/api/qr/${sop.qrPublicToken}/image.png`} download={`${sop.referenceNo}-qr.png`}>
                    Download QR
                  </a>
                  <a className="btn btn-sm" href={`/print/qr/${id}`} target="_blank" rel="noreferrer">
                    Print labels
                  </a>
                  <a className="btn btn-sm" href={`/kiosk/${id}`}>
                    Kiosk mode
                  </a>
                </div>
              </>
            ) : (
              <p className="muted">Publish a version to share it by QR code.</p>
            )}
          </div>

          <div className="card">
            <h3>Versions</h3>
            <ul style={{ paddingLeft: 0, listStyle: 'none', margin: 0 }}>
              {sop.versions.map((sv) => (
                <li key={sv.id} style={{ marginBottom: 6 }}>
                  <Link href={`/sops/${id}?v=${sv.id}`} style={{ fontWeight: sv.id === v?.id ? 700 : 400 }}>
                    v{sv.label}
                  </Link>{' '}
                  <VersionStateBadge state={sv.lifecycleState} />
                  {sv.id === sop.currentPublishedVersionId && <span className="badge badge-green">current</span>}
                  <div className="muted" style={{ fontSize: 12 }}>
                    {fmtDate(sv.publishedAt ?? sv.createdAt)}
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className="card">
            <h3>Details</h3>
            <dl className="kv">
              <dt>Folder</dt>
              <dd>{sop.folder?.name ?? '—'}</dd>
              <dt>Date raised</dt>
              <dd>{fmtDate(sop.createdAt)}</dd>
              <dt>Created by</dt>
              <dd>{sop.createdBy?.name ?? '—'}</dd>
              <dt>Last modified</dt>
              <dd>{fmtDate(sop.updatedAt)}</dd>
            </dl>
            {allowed(role, 'editSops') && (
              <button
                className="btn btn-sm"
                style={{ marginTop: 10 }}
                onClick={() => act(() => api(`/sops/${id}/archive`, { method: 'POST', body: { archived: !sop.archivedAt } }), sop.archivedAt ? 'SOP restored.' : 'SOP archived.')}
              >
                {sop.archivedAt ? 'Unarchive' : 'Archive'}
              </button>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}
