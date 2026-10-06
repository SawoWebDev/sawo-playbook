'use client';

import { useState, type FormEvent } from 'react';
import { api, type Role } from '@/lib/api';
import { errorMessage } from '@/lib/format';
import { ASSIGNABLE_ROLES, roleLabel } from '@/lib/permissions';

export interface GroupOption {
  id: string;
  name: string;
}

interface BulkResult {
  created: { email: string; role: Role; invitationId: string }[];
  errors: { row: number; email?: string; error: string }[];
}

/**
 * Invite one person, or many from CSV. The server decides what is allowed (roles, required groups, Admin rules); this
 * dialog only collects the input and shows the server's answer.
 */
export function InviteDialog({ groups, onClose, onDone }: { groups: GroupOption[]; onClose: () => void; onDone: (message: string) => void }) {
  const [mode, setMode] = useState<'one' | 'csv'>('one');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('OPERATOR');
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [csv, setCsv] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [bulk, setBulk] = useState<BulkResult | null>(null);

  const submitOne = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ inviteUrl: string; email: string }>('/users/invitations', {
        method: 'POST',
        body: { email: email.trim(), role, groupIds },
      });
      setInviteLink(r.inviteUrl);
      onDone(`Invitation sent to ${r.email}.`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submitCsv = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<BulkResult>('/users/invitations/bulk', { method: 'POST', body: { csv } });
      setBulk(r);
      if (r.created.length) onDone(`${r.created.length} invitation${r.created.length === 1 ? '' : 's'} sent.`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleGroup = (id: string) => setGroupIds((g) => (g.includes(id) ? g.filter((x) => x !== id) : [...g, id]));

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div className="card dialog" role="dialog" aria-modal="true" aria-label="Invite people" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>Invite people</h3>
          <div className="spacer" />
          <button className="btn btn-sm" type="button" onClick={() => setMode(mode === 'one' ? 'csv' : 'one')}>
            {mode === 'one' ? 'Bulk from CSV' : 'Invite one person'}
          </button>
        </div>

        {mode === 'one' && !inviteLink && (
          <form onSubmit={submitOne}>
            <div className="field">
              <label htmlFor="inv-email">Email</label>
              <input id="inv-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="inv-role">Role</label>
              <select id="inv-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
                {ASSIGNABLE_ROLES.map((r) => (
                  <option key={r} value={r}>{roleLabel(r)}</option>
                ))}
              </select>
            </div>
            <fieldset style={{ border: 0, padding: 0, marginBottom: 14 }}>
              <legend>Groups</legend>
              {groups.length === 0 ? (
                <p className="muted">No groups exist yet. Create one on the Groups tab first.</p>
              ) : (
                <div className="toggle-row">
                  {groups.map((g) => (
                    <label key={g.id} className="row" style={{ fontWeight: 400, margin: 0 }}>
                      <input type="checkbox" style={{ width: 'auto' }} checked={groupIds.includes(g.id)} onChange={() => toggleGroup(g.id)} />
                      {g.name}
                    </label>
                  ))}
                </div>
              )}
              <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>Everyone except Admins needs at least one group.</p>
            </fieldset>
            {error && <div className="error" role="alert">{error}</div>}
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" type="button" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" type="submit" disabled={busy || !email.trim()}>Send invitation</button>
            </div>
          </form>
        )}

        {mode === 'one' && inviteLink && (
          <div>
            <p>The invitation was sent. If the email does not arrive, share this one-time link with the person:</p>
            <input aria-label="Invite link" readOnly value={inviteLink} style={{ width: '100%' }} onFocus={(e) => e.currentTarget.select()} />
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
              <button className="btn" type="button" onClick={() => navigator.clipboard?.writeText(inviteLink)}>Copy link</button>
              <button className="btn btn-primary" type="button" onClick={onClose}>Done</button>
            </div>
          </div>
        )}

        {mode === 'csv' && (
          <form onSubmit={submitCsv}>
            <p className="muted" style={{ marginTop: 0 }}>
              One person per line with the columns <code>email,role,groups</code>. Separate several groups with <code>;</code>. Each row is checked separately, so one bad row does not stop the rest.
            </p>
            <textarea aria-label="CSV invitations" rows={7} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={'email,role,groups\nalex@example.com,Editor,Safety;Operations'} style={{ width: '100%', fontFamily: 'monospace' }} />
            {error && <div className="error" role="alert">{error}</div>}
            {bulk && (
              <div style={{ marginTop: 10 }}>
                <p>{bulk.created.length} sent, {bulk.errors.length} not sent.</p>
                {bulk.errors.length > 0 && (
                  <ul className="error" style={{ margin: 0, paddingLeft: 18 }}>
                    {bulk.errors.map((x) => (
                      <li key={`${x.row}-${x.email ?? ''}`}>Row {x.row}{x.email ? ` (${x.email})` : ''}: {x.error}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
              <button className="btn" type="button" onClick={onClose}>Close</button>
              <button className="btn btn-primary" type="submit" disabled={busy || !csv.trim()}>Send invitations</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
