'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type Role } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage, fmtDate } from '@/lib/format';
import { ROLE_LABELS } from '@/lib/permissions';

interface UserRow {
  id: string;
  email: string;
  name: string;
  status: 'invited' | 'active' | 'suspended' | 'removed';
  orgRole: Role;
  lastLoginAt: string | null;
  mfaEnabled: boolean;
}

interface InvitationRow {
  id: string;
  email: string;
  orgRole: Role;
  expiresAt: string;
}

const ASSIGNABLE: Role[] = ['ADMIN', 'EDITOR', 'APPROVER', 'TRAINER', 'OPERATOR'];
const STATUS_BADGE: Record<UserRow['status'], string> = {
  active: 'badge-green',
  invited: 'badge-blue',
  suspended: 'badge-amber',
  removed: 'badge-red',
};

export default function UsersPage() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [invites, setInvites] = useState<InvitationRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('OPERATOR');
  const [csv, setCsv] = useState('');
  const [showRemoved, setShowRemoved] = useState(false);

  const assignable = ASSIGNABLE.filter((r) => me?.role === 'OWNER' || r !== 'ADMIN');

  const load = useCallback(async () => {
    try {
      const [u, i] = await Promise.all([api<UserRow[]>('/users'), api<InvitationRow[]>('/users/invitations')]);
      setUsers(u);
      setInvites(i);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(fn: () => Promise<unknown>, ok?: string) {
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (ok) setNotice(ok);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function invite(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      const r = await api<{ inviteUrl: string }>('/users/invitations', {
        method: 'POST',
        body: { email: inviteEmail, role: inviteRole },
      });
      setInviteEmail('');
      setNotice(`Invitation sent. Link: ${r.inviteUrl}`);
    });
  }

  async function bulk(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      const r = await api<{ created: unknown[]; errors: { row: number; email?: string; error: string }[] }>(
        '/users/invitations/bulk',
        { method: 'POST', body: { csv } },
      );
      setCsv('');
      setNotice(
        `${r.created.length} invitation(s) sent.` +
          (r.errors.length ? ` Errors: ${r.errors.map((x) => `row ${x.row} (${x.email ?? '?'}): ${x.error}`).join('; ')}` : ''),
      );
    });
  }

  const canManage = (u: UserRow) =>
    u.id !== me?.id && u.orgRole !== 'OWNER' && !(me?.role === 'ADMIN' && u.orgRole === 'ADMIN');

  const visibleUsers = users.filter((u) => showRemoved || u.status !== 'removed');

  return (
    <>
      <h1>Manage Users</h1>
      {error && <div className="error">{error}</div>}
      {notice && <div className="success" style={{ wordBreak: 'break-all' }}>{notice}</div>}

      <div className="row" style={{ marginBottom: 8 }}>
        <div className="spacer" />
        <label className="row" style={{ fontWeight: 400, margin: 0 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} />
          Show removed
        </label>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
            <th>Status</th>
            <th>2FA</th>
            <th>Last login</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {visibleUsers.map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td>
              <td>{u.email}</td>
              <td>
                {canManage(u) && u.status !== 'removed' ? (
                  <select
                    value={u.orgRole}
                    style={{ width: 'auto' }}
                    onChange={(e) =>
                      run(() => api(`/users/${u.id}/role`, { method: 'PATCH', body: { role: e.target.value } }), 'Role updated — the user has been signed out everywhere.')
                    }
                  >
                    {[...new Set([u.orgRole, ...assignable])].map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </option>
                    ))}
                  </select>
                ) : (
                  ROLE_LABELS[u.orgRole]
                )}
              </td>
              <td>
                <span className={`badge ${STATUS_BADGE[u.status]}`}>{u.status}</span>
              </td>
              <td>{u.mfaEnabled ? <span className="badge badge-green">on</span> : <span className="muted">off</span>}</td>
              <td>{fmtDate(u.lastLoginAt)}</td>
              <td>
                {canManage(u) && (
                  <div className="row" style={{ gap: 6 }}>
                    {u.status === 'active' && (
                      <button className="btn btn-sm" onClick={() => run(() => api(`/users/${u.id}/suspend`, { method: 'POST' }), 'User suspended.')}>
                        Suspend
                      </button>
                    )}
                    {u.status === 'suspended' && (
                      <button className="btn btn-sm" onClick={() => run(() => api(`/users/${u.id}/reactivate`, { method: 'POST' }), 'User reactivated.')}>
                        Reactivate
                      </button>
                    )}
                    {u.mfaEnabled && (
                      <button
                        className="btn btn-sm"
                        onClick={() => {
                          if (confirm(`Reset two-factor authentication for ${u.name}? They will be signed out and can enrol again.`)) {
                            void run(() => api(`/users/${u.id}/mfa/reset`, { method: 'POST' }), 'Two-factor authentication reset.');
                          }
                        }}
                      >
                        Reset 2FA
                      </button>
                    )}
                    {u.status !== 'removed' && (
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => {
                          if (confirm(`Permanently remove ${u.name}? They will no longer be able to sign in.`)) {
                            void run(() => api(`/users/${u.id}/remove`, { method: 'POST' }), 'User removed.');
                          }
                        }}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Pending invitations</h2>
      {invites.length === 0 ? (
        <p className="muted">No pending invitations.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {invites.map((i) => (
              <tr key={i.id}>
                <td>{i.email}</td>
                <td>{ROLE_LABELS[i.orgRole]}</td>
                <td>{fmtDate(i.expiresAt)}</td>
                <td>
                  <button className="btn btn-sm btn-danger" onClick={() => run(() => api(`/users/invitations/${i.id}`, { method: 'DELETE' }), 'Invitation revoked.')}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="grid" style={{ marginTop: 24, gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        <form className="card" onSubmit={invite}>
          <h3 style={{ marginTop: 0 }}>Invite a user</h3>
          <div className="field">
            <label htmlFor="inv-email">Email</label>
            <input id="inv-email" type="email" required value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="inv-role">Role</label>
            <select id="inv-role" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)}>
              {assignable.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
          <button className="btn btn-primary" type="submit">
            Send invitation
          </button>
        </form>

        <form className="card" onSubmit={bulk}>
          <h3 style={{ marginTop: 0 }}>Bulk invite (CSV)</h3>
          <div className="field">
            <label htmlFor="csv">
              Paste CSV with columns <code>email,role</code>
            </label>
            <textarea id="csv" rows={5} placeholder={'email,role\nalex@example.com,editor'} value={csv} onChange={(e) => setCsv(e.target.value)} />
          </div>
          <div className="row">
            <input
              type="file"
              accept=".csv,text/csv"
              style={{ width: 'auto', border: 0, padding: 0 }}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setCsv(await f.text());
              }}
            />
            <div className="spacer" />
            <button className="btn btn-primary" type="submit" disabled={!csv.trim()}>
              Send invitations
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
