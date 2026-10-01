'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Icons } from '@/components/Subbar';
import { api, apiRaw } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage, fmtDate, fmtDateTime } from '@/lib/format';
import { allowed } from '@/lib/permissions';
import type { SopDetail, SopListItem, VersionDetail } from '@/lib/types';

type Dialog = 'training' | 'history' | 'folder' | 'changes' | null;

interface HistoryRow {
  id: string;
  associate: { id: string; name: string };
  trainer: { id: string; name: string };
  versionLabel: string;
  levelLabel: string;
  assessedAt: string;
  notes: string | null;
}

interface Matrix {
  levels: { value: number; label: string }[];
  associates: { id: string; name: string; editable: boolean }[];
}

/** "•••" dropdown on an STD OPS list card: edit, duplicate, training, folder, change history and PDF. */
export function SopCardMenu({
  sop,
  folders,
  onChanged,
  onError,
}: {
  sop: SopListItem;
  folders: { id: string; name: string; depth: number }[];
  onChanged: (notice?: string) => void;
  onError: (msg: string) => void;
}) {
  const { user } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [up, setUp] = useState(false);
  const role = user?.role;
  const canEdit = allowed(role, 'editSops');
  const canTrain = allowed(role, 'updateSkills');
  const canSeeTraining = allowed(role, 'viewSkills');
  const pdfVersionId = sop.activeVersion?.id ?? sop.currentPublishedVersion?.id;

  async function run(fn: () => Promise<void>) {
    setOpen(false);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const edit = () =>
    run(async () => {
      const a = sop.activeVersion;
      if (a?.lifecycleState === 'DRAFT') return router.push(`/sops/${sop.id}/edit/${a.id}`);
      if (a) return router.push(`/sops/${sop.id}`); // awaiting approval/publish: review on the detail page
      const nv = await api<VersionDetail>(`/sops/${sop.id}/versions`, { method: 'POST' });
      router.push(`/sops/${sop.id}/edit/${nv.id}`);
    });

  const duplicate = () =>
    run(async () => {
      const copy = await api<SopDetail>(`/sops/${sop.id}/duplicate`, { method: 'POST' });
      router.push(copy.activeVersionId ? `/sops/${copy.id}/edit/${copy.activeVersionId}` : `/sops/${copy.id}`);
    });

  const printPdf = () =>
    run(async () => {
      const res = await apiRaw(`/sops/${sop.id}/versions/${pdfVersionId}/print`);
      if (!res.ok) throw new Error(`Print view failed (${res.status})`);
      const url = URL.createObjectURL(await res.blob());
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    });

  // Only never-published SOPs (e.g. an unwanted duplicate) can be deleted; published ones are archived instead.
  const canDelete = canEdit && !sop.currentPublishedVersion;
  const remove = () => {
    if (!confirm(`Delete "${sop.name}"? This draft SOP will be removed.`)) return setOpen(false);
    void run(async () => {
      await api(`/sops/${sop.id}`, { method: 'DELETE' });
      onChanged(`Deleted ${sop.referenceNo}.`);
    });
  };

  const show = (d: Dialog) => {
    setOpen(false);
    setDialog(d);
  };

  return (
    <div className="menu card-menu">
      <button
        className="more"
        aria-label={`Actions for ${sop.name}`}
        aria-expanded={open}
        disabled={busy}
        onClick={(e) => {
          // open upwards when the menu would run past the bottom of the window
          const r = e.currentTarget.getBoundingClientRect();
          setUp(window.innerHeight - r.bottom < 400 && r.top > window.innerHeight - r.bottom);
          setOpen((o) => !o);
        }}
      >
        •••
      </button>
      {open && (
        <div className={`menu-list icon-menu${up ? ' up' : ''}`} onMouseLeave={() => setOpen(false)}>
          {canEdit && <Item icon={Icons.pencil} label="Edit" onClick={edit} />}
          {canEdit && <Item icon={Icons.copy} label="Duplicate" onClick={duplicate} />}
          <Item icon={Icons.globe} label="Translate" note="coming soon" />
          {canTrain && <Item icon={Icons.training} label="Update Training Record" onClick={() => show('training')} />}
          {canSeeTraining && <Item icon={Icons.record} label="Training History" onClick={() => show('history')} />}
          {canEdit && <Item icon={Icons.folder} label="Add to Folder" onClick={() => show('folder')} />}
          <Item icon={Icons.history} label="Change History" onClick={() => show('changes')} />
          {pdfVersionId && <Item icon={Icons.eye} label="View or Print PDF" onClick={printPdf} />}
          {canDelete && <Item icon={Icons.trash} label="Delete" danger onClick={remove} />}
        </div>
      )}
      {dialog && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <div className="card dialog" style={{ maxWidth: dialog === 'folder' || dialog === 'training' ? 460 : 680 }} onClick={(e) => e.stopPropagation()}>
            {dialog === 'folder' && <FolderDialog sop={sop} folders={folders} onClose={(n) => (setDialog(null), n && onChanged(n))} />}
            {dialog === 'training' && <TrainingDialog sop={sop} onClose={(n) => (setDialog(null), n && onChanged(n))} />}
            {dialog === 'history' && <TrainingHistory sop={sop} onClose={() => setDialog(null)} />}
            {dialog === 'changes' && <ChangeHistory sop={sop} onClose={() => setDialog(null)} />}
          </div>
        </div>
      )}
    </div>
  );
}

function Item({ icon, label, note, danger, onClick }: { icon: ReactNode; label: string; note?: string; danger?: boolean; onClick?: () => void }) {
  return (
    <button type="button" className={danger ? 'danger' : undefined} disabled={!onClick} onClick={onClick}>
      {icon}
      <span>{label}</span>
      {note && <span className="muted note">({note})</span>}
    </button>
  );
}

function DialogHead({ title, sop }: { title: string; sop: SopListItem }) {
  return (
    <>
      <h3 style={{ margin: '0 0 2px' }}>{title}</h3>
      <p className="muted" style={{ margin: '0 0 12px', fontSize: 13 }}>
        {sop.referenceNo} — {sop.name}
      </p>
    </>
  );
}

function FolderDialog({ sop, folders, onClose }: { sop: SopListItem; folders: { id: string; name: string; depth: number }[]; onClose: (notice?: string) => void }) {
  const [folderId, setFolderId] = useState(sop.folder?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api(`/sops/${sop.id}`, { method: 'PATCH', body: { folderId: folderId || null } });
          onClose(folderId ? `Moved to ${folders.find((f) => f.id === folderId)?.name}.` : 'Removed from folder.');
        } catch (err) {
          setError(errorMessage(err));
        }
      }}
    >
      <DialogHead title="Add to Folder" sop={sop} />
      <div className="field">
        <label htmlFor="move-folder">Folder</label>
        <select id="move-folder" value={folderId} onChange={(e) => setFolderId(e.target.value)}>
          <option value="">(not in a folder)</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {'  '.repeat(f.depth)}
              {f.name}
            </option>
          ))}
        </select>
      </div>
      {folders.length === 0 && (
        <p className="muted" style={{ fontSize: 13 }}>
          No folders yet. <Link href="/folders">Create one</Link>.
        </p>
      )}
      {error && <div className="error">{error}</div>}
      <div className="row">
        <div className="spacer" />
        <button type="button" className="btn" onClick={() => onClose()}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary">
          Save
        </button>
      </div>
    </form>
  );
}

function TrainingDialog({ sop, onClose }: { sop: SopListItem; onClose: (notice?: string) => void }) {
  const [m, setM] = useState<Matrix | null>(null);
  const [associateId, setAssociateId] = useState('');
  const [level, setLevel] = useState(1);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Matrix>('/skills/matrix').then(setM).catch((e) => setError(errorMessage(e)));
  }, []);

  const associates = m?.associates.filter((a) => a.editable) ?? [];

  if (!sop.currentPublishedVersion) {
    return (
      <>
        <DialogHead title="Update Training Record" sop={sop} />
        <p className="muted">Training is recorded against the published version. Publish this SOP first.</p>
        <div className="row">
          <div className="spacer" />
          <button className="btn" onClick={() => onClose()}>
            Close
          </button>
        </div>
      </>
    );
  }

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api('/skills/assessments', { method: 'POST', body: { associateId, sopId: sop.id, level, notes: notes.trim() || undefined } });
          onClose(`Training record updated for ${associates.find((a) => a.id === associateId)?.name}.`);
        } catch (err) {
          setError(errorMessage(err));
        }
      }}
    >
      <DialogHead title="Update Training Record" sop={sop} />
      <div className="field">
        <label htmlFor="tr-associate">Associate</label>
        <select id="tr-associate" required value={associateId} onChange={(e) => setAssociateId(e.target.value)}>
          <option value="">{m ? (associates.length ? 'Choose…' : 'No associates you can assess') : 'Loading…'}</option>
          {associates.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="tr-level">Competency level</label>
        <select id="tr-level" value={level} onChange={(e) => setLevel(Number(e.target.value))}>
          {(m?.levels ?? []).map((l) => (
            <option key={l.value} value={l.value}>
              {l.value} — {l.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="tr-notes">Notes</label>
        <textarea id="tr-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>Recorded against {sop.currentPublishedVersion.label}.</p>
      {error && <div className="error">{error}</div>}
      <div className="row">
        <div className="spacer" />
        <button type="button" className="btn" onClick={() => onClose()}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={!associateId}>
          Save
        </button>
      </div>
    </form>
  );
}

function TrainingHistory({ sop, onClose }: { sop: SopListItem; onClose: () => void }) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<HistoryRow[]>(`/skills/history?sopId=${sop.id}`).then(setRows).catch((e) => setError(errorMessage(e)));
  }, [sop.id]);
  return (
    <>
      <DialogHead title="Training History" sop={sop} />
      {error && <div className="error">{error}</div>}
      {!rows && !error && <p className="muted">Loading…</p>}
      {rows && rows.length === 0 && <p className="muted">No training recorded for this SOP yet.</p>}
      {rows && rows.length > 0 && (
        <div className="dialog-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Associate</th>
                <th>Level</th>
                <th>Version</th>
                <th>Trainer</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} title={r.notes ?? undefined}>
                  <td>{fmtDateTime(r.assessedAt)}</td>
                  <td>{r.associate.name}</td>
                  <td>{r.levelLabel}</td>
                  <td>{r.versionLabel}</td>
                  <td>{r.trainer.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row" style={{ marginTop: 12 }}>
        <div className="spacer" />
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </>
  );
}

const STATE_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Pending approval',
  APPROVED: 'Approved',
  PUBLISHED: 'Published',
  ABANDONED: 'Discarded',
};

function ChangeHistory({ sop, onClose }: { sop: SopListItem; onClose: () => void }) {
  const [detail, setDetail] = useState<SopDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<SopDetail>(`/sops/${sop.id}`).then(setDetail).catch((e) => setError(errorMessage(e)));
  }, [sop.id]);
  const versions = detail ? [...detail.versions].sort((a, b) => b.versionSequence - a.versionSequence) : [];
  return (
    <>
      <DialogHead title="Change History" sop={sop} />
      {error && <div className="error">{error}</div>}
      {!detail && !error && <p className="muted">Loading…</p>}
      {detail && (
        <div className="dialog-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Version</th>
                <th>Status</th>
                <th>Created</th>
                <th>Published</th>
                <th>Change summary</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id}>
                  <td>
                    <b>{v.label}</b>
                    {v.id === detail.currentPublishedVersionId && <span className="badge badge-green" style={{ marginLeft: 6 }}>current</span>}
                  </td>
                  <td>{STATE_LABEL[v.lifecycleState] ?? v.lifecycleState}</td>
                  <td>{fmtDate(v.createdAt)}</td>
                  <td>{v.publishedAt ? fmtDate(v.publishedAt) : '—'}</td>
                  <td>{v.changeSummary || <span className="muted">—</span>}</td>
                  <td>
                    <Link href={`/sops/${sop.id}?v=${v.id}`}>View</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row" style={{ marginTop: 12 }}>
        <div className="spacer" />
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </>
  );
}
