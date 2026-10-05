'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { AdvancedOptions } from '@/components/AdvancedOptions';
import { ChangeHistory, FolderDialog, Item } from '@/components/SopCardMenu';
import { SopStatusBadge, VersionStateBadge } from '@/components/StatusBadge';
import { StepsView } from '@/components/StepsView';
import { Icons, SubbarLeft, SubbarRight } from '@/components/Subbar';
import { api, apiRaw } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage, fmtDate, fmtDateTime, fmtDuration, plural } from '@/lib/format';
import { allowed } from '@/lib/permissions';
import { buildTree, flatten, type FolderRow } from '@/lib/folders';
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
  const [approvalRequired, setApprovalRequired] = useState(false);
  const [more, setMore] = useState(false);
  const [dialog, setDialog] = useState<'folder' | 'changes' | null>(null);
  const [folders, setFolders] = useState<FolderRow[]>([]);

  const selected = search.get('v');

  const load = useCallback(async () => {
    try {
      const [s, org] = await Promise.all([
        api<SopDetail>(`/sops/${id}`),
        api<{ settings: { approvalRequired: boolean } }>('/organization'),
      ]);
      setSop(s);
      setApprovalRequired(org.settings.approvalRequired);
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

  useEffect(() => {
    api<FolderRow[]>('/folders').then(setFolders).catch(() => undefined);
  }, []);

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

  async function duplicate() {
    setMore(false);
    setBusy(true);
    setError(null);
    try {
      const copy = await api<SopDetail>(`/sops/${id}/duplicate`, { method: 'POST' });
      router.push(copy.activeVersionId ? `/sops/${copy.id}/edit/${copy.activeVersionId}` : `/sops/${copy.id}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  async function openPrint() {
    if (!version) return;
    setBusy(true);
    try {
      const res = await apiRaw(`/sops/${id}/versions/${version.id}/print`);
      if (!res.ok) throw new Error(`Print view failed (${res.status})`);
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
  const hasActions =
    !!v &&
    ((allowed(role, 'editSops') && ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(v.lifecycleState)) ||
      (canApprove && v.lifecycleState === 'PENDING_APPROVAL') ||
      (canPublish && v.lifecycleState === 'APPROVED') ||
      (v.lifecycleState === 'PUBLISHED' && v.id === sop.currentPublishedVersionId && v.config.checklist_sop));
  const qrLink = typeof window !== 'undefined' ? `${window.location.origin}/s/${sop.qrPublicToken}` : '';

  return (
    <>
      <SubbarLeft>
        <Link href="/sops" className="back-btn">
          <span className="back-chev">‹</span> Back
        </Link>
        <strong className="bar-title">{sop.name}</strong>
      </SubbarLeft>
      <SubbarRight>
        {v && canEdit && v.lifecycleState === 'DRAFT' && (
          <Link className="btn btn-blue" href={`/sops/${id}/edit/${v.id}`}>
            {Icons.pencil} Edit draft
          </Link>
        )}
        {v && canEdit && v.lifecycleState === 'PUBLISHED' && !sop.activeVersionId && (
          <button
            className="btn btn-blue"
            disabled={busy}
            onClick={() =>
              act(async () => {
                const nv = await api<VersionDetail>(`/sops/${id}/versions`, { method: 'POST' });
                router.push(`/sops/${id}/edit/${nv.id}`);
              }, 'New draft version created.')
            }
          >
            {Icons.pencil} Edit
          </button>
        )}
        {v && canEdit && sop.activeVersionId && v.id !== sop.activeVersionId && (
          <Link className="btn btn-blue" href={`/sops/${id}/edit/${sop.activeVersionId}`}>
            {Icons.pencil} Continue editing draft
          </Link>
        )}
        <div className="menu">
          <button className="kebab" aria-label="More options" aria-expanded={more} onClick={() => setMore((o) => !o)}>
            ⋮
          </button>
          {more && (
            <div className="menu-list more-menu icon-menu" onMouseLeave={() => setMore(false)}>
              {canEdit && <Item icon={Icons.copy} label="Duplicate" onClick={() => void duplicate()} />}
              {canEdit && (
                <Item
                  icon={Icons.folder}
                  label="Add to Folder"
                  onClick={() => {
                    setMore(false);
                    setDialog('folder');
                  }}
                />
              )}
              <Item
                icon={Icons.history}
                label="Change History"
                onClick={() => {
                  setMore(false);
                  setDialog('changes');
                }}
              />
              <div className="more-title">Versions</div>
              {sop.versions.map((sv) => (
                <Link key={sv.id} href={`/sops/${id}?v=${sv.id}`} className="more-version" onClick={() => setMore(false)}>
                  <span style={{ fontWeight: sv.id === v?.id ? 700 : 400 }}>v{sv.label}</span> <VersionStateBadge state={sv.lifecycleState} />
                  {sv.id === sop.currentPublishedVersionId && <span className="badge badge-green">current</span>}
                  <span className="muted"> · {fmtDate(sv.publishedAt ?? sv.createdAt)}</span>
                </Link>
              ))}
              <div className="more-title">Details</div>
              <dl className="kv more-kv">
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
                  onClick={() => {
                    setMore(false);
                    void act(() => api(`/sops/${id}/archive`, { method: 'POST', body: { archived: !sop.archivedAt } }), sop.archivedAt ? 'SOP restored.' : 'SOP archived.');
                  }}
                >
                  {sop.archivedAt ? 'Unarchive' : 'Archive'}
                </button>
              )}
            </div>
          )}
        </div>
      </SubbarRight>

      {dialog && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <div className="card dialog" style={{ maxWidth: dialog === 'folder' ? 460 : 820 }} onClick={(e) => e.stopPropagation()}>
            {dialog === 'folder' && (
              <FolderDialog
                sop={sop}
                folders={flatten(buildTree(folders))}
                onClose={(n) => {
                  setDialog(null);
                  if (n) {
                    setNotice(n);
                    void load();
                  }
                }}
              />
            )}
            {dialog === 'changes' && <ChangeHistory sop={sop} onClose={() => setDialog(null)} />}
          </div>
        </div>
      )}

      <div className="layout-2">
        <div>
      <div className="info-card">
        <div>
          <div className="info-label">Procedure Name</div>
          <div className="info-value">{sop.name}</div>
        </div>
        <div>
          <div className="info-label">Created By</div>
          <div className="info-value">{sop.createdBy?.name ?? 'N/A'}</div>
        </div>
      </div>

      {v && (
        <>
          <h3 className="sec-title">SOP Configuration</h3>
          <div className="cfg-row">
            <div className="cfg">
              <div className="cfg-name">Checklist SOP</div>
              <div className="cfg-desc">Capture data while operators complete the SOP.</div>
              <span className={v.config.checklist_sop ? 'pill pill-on' : 'pill'}>● {v.config.checklist_sop ? 'On' : 'Off'}</span>
            </div>
            <div className="cfg">
              <div className="cfg-name">Cover Sheet</div>
              <div className="cfg-desc">Include a cover sheet as the first page of the SOP.</div>
              <span className={v.config.cover_sheet ? 'pill pill-on' : 'pill'}>● {v.config.cover_sheet ? 'On' : 'Off'}</span>
            </div>
          </div>
        </>
      )}

      {error && <div className="error">{error}</div>}
      {notice && <div className="success">{notice}</div>}
      {lastRejection && (
        <div className="card" style={{ borderColor: '#f1c4c0', marginBottom: 12 }}>
          <span className="badge badge-red">Rejected</span> by {lastRejection.approver.name}: {lastRejection.comment}
        </div>
      )}

          {v && (
            <>
              <AdvancedOptions
                config={v.config}
                referenceNo={sop.referenceNo}
                raisedAt={sop.createdAt}
                revision={v.label}
                revisionDate={v.publishedAt ?? v.createdAt}
                cycleTimeSeconds={v.cycleTimeSeconds}
              />
              <h3 className="view-steps">View steps</h3>
              <StepsView steps={v.steps} showTitles={sop.type === 'advanced'} />
            </>
          )}
        </div>

        <aside className="panel">
          {v && hasActions && (
            <div className="card">
              <h3>Actions</h3>
              <div className="panel">
                {allowed(role, 'editSops') && v.lifecycleState === 'DRAFT' && !approvalRequired && (
                  <button className="btn" disabled={busy || v.steps.length === 0} onClick={() => act(() => api(`${vUrl}/finish`, { method: 'POST', body: {} }), 'Version published.')}>
                    Publish
                  </button>
                )}
                {allowed(role, 'editSops') && v.lifecycleState === 'DRAFT' && approvalRequired && (
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
                    Discard draft
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

          {v && (
            <div className="opt-card">
              <div className="opt-head">View or Print Options</div>
              <div className="opt-body">
                <button className="opt-btn" disabled={busy} onClick={openPrint}>
                  View or Print PDF
                </button>
                <Link className="opt-btn" href={`/kiosk/${id}`}>
                  View Step By Step
                </Link>
                {sop.currentPublishedVersionId ? (
                  <>
                    <a className="opt-btn" href={`/print/qr/${id}`} target="_blank" rel="noreferrer">
                      View or Print QR Code
                    </a>
                    <a className="opt-btn outline" href={`/print/qr/${id}`} target="_blank" rel="noreferrer">
                      View or Print Green/Red Code PDF
                    </a>
                  </>
                ) : (
                  <p className="muted" style={{ fontSize: 12, margin: 0 }}>Publish a version to print its QR code.</p>
                )}
              </div>
            </div>
          )}

          {sop.currentPublishedVersionId && (
            <>
              <div className="opt-card">
                <div className="opt-head">Share Options</div>
                <div className="opt-body">
                  <button className="opt-btn" onClick={() => navigator.clipboard?.writeText(qrLink).then(() => setNotice('Link copied.'))}>
                    Share PDF / Link
                  </button>
                  <a className="opt-btn outline" href={`/api/qr/${sop.qrPublicToken}/image.png`} download={`${sop.referenceNo}-qr.png`}>
                    Share QR Code
                  </a>
                  <button
                    className="opt-btn outline"
                    onClick={() => navigator.clipboard?.writeText(`${window.location.origin}/sops/${id}`).then(() => setNotice('Link copied.'))}
                  >
                    Share Link to View SOP in App
                  </button>
                </div>
              </div>
              <button className="regen" onClick={() => void load()}>
                Issue with PDF/QR Code? Click to regenerate
              </button>
            </>
          )}

        </aside>
      </div>
    </>
  );
}
