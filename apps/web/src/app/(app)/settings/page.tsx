'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage, fmtDate } from '@/lib/format';
import { allowed } from '@/lib/permissions';

interface OrgInfo {
  id: string;
  name: string;
  status: 'active' | 'pending_deletion' | 'suspended' | 'deleted';
  deletionScheduledFor: string | null;
  settings: { approvalQuorum: number; allowSelfApproval: boolean; publicSopViewing: boolean };
}

export default function SettingsPage() {
  const { user } = useAuth();
  const [org, setOrg] = useState<OrgInfo | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmName, setConfirmName] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    api<OrgInfo>('/organization').then(setOrg).catch((e) => setMsg({ ok: false, text: errorMessage(e) }));
  }, []);

  if (!org) return <p className="muted">Loading…</p>;

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      setOrg(await api<OrgInfo>('/organization/settings', { method: 'PATCH', body: org!.settings }));
      setMsg({ ok: true, text: 'Settings saved.' });
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
    }
  }

  const setSetting = <K extends keyof OrgInfo['settings']>(k: K, v: OrgInfo['settings'][K]) =>
    setOrg({ ...org, settings: { ...org.settings, [k]: v } });

  return (
    <>
      <h1>{org.name} — Organization settings</h1>
      {msg && <div className={msg.ok ? 'success' : 'error'}>{msg.text}</div>}

      <form className="card" onSubmit={save} style={{ maxWidth: 560 }}>
        <div className="field">
          <label htmlFor="quorum">Approval quorum (distinct approvers required)</label>
          <input id="quorum" type="number" min={1} max={20} value={org.settings.approvalQuorum} onChange={(e) => setSetting('approvalQuorum', Number(e.target.value))} />
        </div>
        <div className="field">
          <label className="row" style={{ fontWeight: 400 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={org.settings.allowSelfApproval} onChange={(e) => setSetting('allowSelfApproval', e.target.checked)} />
            Allow the submitter of a version to also approve it
          </label>
        </div>
        <div className="field">
          <label className="row" style={{ fontWeight: 400 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={org.settings.publicSopViewing} onChange={(e) => setSetting('publicSopViewing', e.target.checked)} />
            Allow viewing published SOPs via QR without signing in
          </label>
        </div>
        <button className="btn btn-primary" type="submit">
          Save settings
        </button>
      </form>

      {allowed(user?.role, 'deleteOrg') && (
        <div className="card" style={{ maxWidth: 560, marginTop: 24, borderColor: '#f1c4c0' }}>
          <h3 style={{ marginTop: 0, color: 'var(--danger)' }}>Delete organization</h3>
          {org.status === 'pending_deletion' ? (
            <>
              <p>
                Deletion is scheduled for <strong>{fmtDate(org.deletionScheduledFor)}</strong>. You can cancel until then.
              </p>
              <button
                className="btn"
                onClick={async () => {
                  try {
                    setOrg(await api<OrgInfo>('/organization/deletion', { method: 'DELETE' }));
                    setMsg({ ok: true, text: 'Deletion cancelled.' });
                  } catch (err) {
                    setMsg({ ok: false, text: errorMessage(err) });
                  }
                }}
              >
                Cancel deletion
              </button>
            </>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  setOrg(await api<OrgInfo>('/organization/deletion', { method: 'POST', body: { confirmName, password } }));
                  setPassword('');
                  setMsg({ ok: true, text: 'Deletion requested. A 14-day cooldown has started.' });
                } catch (err) {
                  setMsg({ ok: false, text: errorMessage(err) });
                }
              }}
            >
              <p className="muted">
                All data will be deleted after a 14-day cooldown. Compliance records are retained until their retention window ends.
              </p>
              <div className="field">
                <label htmlFor="cn">Type the organization name to confirm</label>
                <input id="cn" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="pw">Your password</label>
                <input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
              <button className="btn btn-danger" type="submit" disabled={confirmName !== org.name || !password}>
                Request deletion
              </button>
            </form>
          )}
        </div>
      )}
    </>
  );
}
