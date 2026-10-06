'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type Role } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage, fmtDate } from '@/lib/format';
import { ASSIGNABLE_ROLES, hasPermission, roleLabel } from '@/lib/permissions';
import { UserManagementTabs } from '@/components/UserManagementTabs';
import { STATUS_BADGE, STATUS_LABEL, type UserRow } from '@/components/users/shared';
import type { GroupOption } from '@/components/users/InviteDialog';

interface UserDetail {
  id: string;
  name: string;
  email: string;
  orgRole: Role;
  status: UserRow['status'];
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  groups: { id: string; name: string }[];
  approvalReadiness: { ready: boolean; issue: string | null };
}

type Pending = { kind: 'suspend' } | { kind: 'reactivate' } | { kind: 'remove' } | { kind: 'mfa' } | null;

/**
 * One person's account. Every change calls an existing endpoint; the server decides what is allowed (including the
 * Admin-over-Admin rule) and its message is shown as-is.
 */
export default function UserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user: me } = useAuth();
  const canManage = hasPermission(me, 'users.manage');
  const canGroups = hasPermission(me, 'groups.manage');
  const [person, setPerson] = useState<UserDetail | null>(null);
  const [allGroups, setAllGroups] = useState<GroupOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('OPERATOR');
  const [groupIds, setGroupIds] = useState<string[]>([]);

  const load = useCallback(async () => {
    const d = await api<UserDetail>(`/users/${id}`);
    setPerson(d);
    setName(d.name);
    setEmail(d.email);
    setRole(d.orgRole);
    setGroupIds(d.groups.map((g) => g.id));
  }, [id]);

  useEffect(() => {
    if (!canManage) return;
    load().catch((e) => setError(errorMessage(e)));
    if (canGroups) api<GroupOption[]>('/groups').then(setAllGroups).catch(() => undefined);
  }, [canManage, canGroups, load]);

  /** Runs one change, shows the server's result and reloads. */
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const saveProfile = (e: FormEvent) => {
    e.preventDefault();
    if (!person) return;
    const body: { name?: string; email?: string } = {};
    if (name.trim() !== person.name) body.name = name.trim();
    if (email.trim().toLowerCase() !== person.email) body.email = email.trim();
    if (!Object.keys(body).length) return;
    run(() => api(`/users/${id}`, { method: 'PATCH', body }), body.email ? 'Profile saved. The person is signed out everywhere because their email changed.' : 'Profile saved.');
  };

  const saveRole = () => {
    if (!person || role === person.orgRole) return;
    run(() => api(`/users/${id}/role`, { method: 'PATCH', body: { role } }), `Role changed to ${roleLabel(role)}. The person is signed out everywhere.`);
  };

  /** Saves the group set: adds and removes are sent one at a time, and the first refusal stops the run. */
  const saveGroups = async () => {
    if (!person) return;
    const before = new Set(person.groups.map((g) => g.id));
    const after = new Set(groupIds);
    const added = [...after].filter((g) => !before.has(g));
    const removed = [...before].filter((g) => !after.has(g));
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      for (const g of added) await api(`/groups/${g}/members`, { method: 'POST', body: { userIds: [id] } });
      for (const g of removed) await api(`/groups/${g}/members/${id}`, { method: 'DELETE' });
      setNotice('Groups saved.');
      await load();
    } catch (e) {
      setError(errorMessage(e));
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const confirmAndRun = () => {
    const p = pending;
    setPending(null);
    if (!p || !person) return;
    if (p.kind === 'suspend') run(() => api(`/users/${id}/suspend`, { method: 'POST' }), 'Suspended. Their sessions are ended.');
    if (p.kind === 'reactivate') run(() => api(`/users/${id}/reactivate`, { method: 'POST' }), 'Reactivated.');
    if (p.kind === 'remove') run(() => api(`/users/${id}/remove`, { method: 'POST' }), 'Removed. They can no longer sign in; their history is kept.');
    if (p.kind === 'mfa') run(() => api(`/users/${id}/mfa/reset`, { method: 'POST' }), 'Two-factor sign-in reset. Their sessions are ended.');
  };

  if (!canManage) {
    return (
      <>
        <h1>User Management</h1>
        <UserManagementTabs />
        <p className="muted">Only Admins can manage users.</p>
      </>
    );
  }

  return (
    <>
      <h1>User Management</h1>
      <UserManagementTabs />
      <p style={{ marginTop: 0 }}><Link href="/users">← All people</Link></p>
      {error && <div className="error" role="alert">{error}</div>}
      {notice && <div className="success">{notice}</div>}
      {!person && !error && <p className="muted" role="status">Loading…</p>}

      {person && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
          <section className="card" aria-label="Identity">
            <div className="row" style={{ marginBottom: 10 }}>
              <h3 style={{ margin: 0 }}>{person.name}</h3>
              <div className="spacer" />
              <span className={`badge ${STATUS_BADGE[person.status]}`}>{STATUS_LABEL[person.status]}</span>
            </div>
            <form onSubmit={saveProfile}>
              <div className="field">
                <label htmlFor="u-name">Name</label>
                <input id="u-name" value={name} onChange={(e) => setName(e.target.value)} disabled={!canManage || busy} maxLength={200} />
              </div>
              <div className="field">
                <label htmlFor="u-email">Email</label>
                <input id="u-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={!canManage || busy} maxLength={320} />
                <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Changing the email signs the person out everywhere, because the email is their sign-in.</p>
              </div>
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="btn btn-primary btn-sm" type="submit" disabled={busy || (name.trim() === person.name && email.trim().toLowerCase() === person.email)}>Save profile</button>
              </div>
            </form>
            <dl className="muted" style={{ marginTop: 14, fontSize: 13 }}>
              <dt>Added</dt>
              <dd style={{ margin: 0 }}>{fmtDate(person.createdAt)}</dd>
              <dt>Last sign-in</dt>
              <dd style={{ margin: 0 }}>{person.lastLoginAt ? fmtDate(person.lastLoginAt) : 'Never'}</dd>
              <dt>Two-factor sign-in</dt>
              <dd style={{ margin: 0 }}>{person.mfaEnabled ? 'On' : 'Off'}</dd>
            </dl>
          </section>

          <section className="card" aria-label="Role and access">
            <h3 style={{ marginTop: 0 }}>Role</h3>
            <div className="row">
              <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as Role)} disabled={!canManage || busy}>
                {ASSIGNABLE_ROLES.map((r) => (
                  <option key={r} value={r}>{roleLabel(r)}</option>
                ))}
              </select>
              <button className="btn btn-sm" type="button" disabled={busy || role === person.orgRole} onClick={saveRole}>Change role</button>
            </div>
            <p className="muted" style={{ fontSize: 12 }}>A role change signs the person out everywhere. The server refuses changes it does not allow and says why.</p>

            <h3>Groups</h3>
            <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
              Approvals are routed by group, so a person&apos;s groups decide which reviewers see their submissions. Groups are not granted by role.
            </p>
            {!canGroups ? (
              <p className="muted">Only Admins can change groups.</p>
            ) : allGroups.length === 0 ? (
              <p className="muted">No groups exist yet. Create one on the Groups tab.</p>
            ) : (
              <>
                <div className="toggle-row" style={{ marginBottom: 10 }}>
                  {allGroups.map((g) => (
                    <label key={g.id} className="row" style={{ fontWeight: 400, margin: 0 }}>
                      <input type="checkbox" style={{ width: 'auto' }} checked={groupIds.includes(g.id)} disabled={busy} onChange={() => setGroupIds((x) => (x.includes(g.id) ? x.filter((v) => v !== g.id) : [...x, g.id]))} />
                      {g.name}
                    </label>
                  ))}
                </div>
                <div className="row" style={{ justifyContent: 'flex-end' }}>
                  <button className="btn btn-sm btn-primary" type="button" disabled={busy} onClick={saveGroups}>Save groups</button>
                </div>
              </>
            )}
          </section>

          <section className="card" aria-label="Approval readiness">
            <h3 style={{ marginTop: 0 }}>Approval</h3>
            {person.approvalReadiness.ready ? (
              <span className="badge badge-green">Ready for approval mail</span>
            ) : (
              <div className="error" role="status">{person.approvalReadiness.issue ?? 'Not ready for approvals'}</div>
            )}
            <p className="muted" style={{ fontSize: 13 }}>
              Pre Approver and Approver accounts need an active account with a deliverable email to receive approval requests.
            </p>
          </section>

          <section className="card" aria-label="Account actions">
            <h3 style={{ marginTop: 0 }}>Account</h3>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {person.status === 'active' && (
                <button className="btn btn-sm" type="button" disabled={busy} onClick={() => setPending({ kind: 'suspend' })}>Suspend</button>
              )}
              {person.status === 'suspended' && (
                <button className="btn btn-sm" type="button" disabled={busy} onClick={() => setPending({ kind: 'reactivate' })}>Reactivate</button>
              )}
              {person.mfaEnabled && (
                <button className="btn btn-sm" type="button" disabled={busy} onClick={() => setPending({ kind: 'mfa' })}>Reset two-factor sign-in</button>
              )}
            </div>
            {person.status !== 'removed' && (
              <div style={{ marginTop: 22, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>Removing someone blocks their sign-in. Their history is kept.</p>
                <button className="btn btn-danger btn-sm" type="button" disabled={busy} onClick={() => setPending({ kind: 'remove' })}>Remove person</button>
              </div>
            )}
            <p className="muted" style={{ fontSize: 12, marginTop: 14 }}>
              Sessions are ended by suspend, remove, role change, email change and two-factor reset. The API does not offer a per-session list.
            </p>
          </section>

          <section className="card" aria-label="Effective permissions" style={{ gridColumn: '1 / -1' }}>
            <h3 style={{ marginTop: 0 }}>What this person can do</h3>
            <p className="muted" style={{ margin: 0 }}>
              Their permissions come from their role and the organisation&apos;s role settings. The API does not expose another person&apos;s effective permissions, so this screen does not list them.
              See <Link href="/roles">Roles &amp; Permissions</Link> for each role&apos;s permissions.
            </p>
          </section>
        </div>
      )}

      {pending && person && (
        <div className="dialog-backdrop" role="presentation" onClick={() => setPending(null)}>
          <div className="card dialog" role="dialog" aria-modal="true" aria-label="Confirm" onClick={(e) => e.stopPropagation()}>
            <h3>
              {pending.kind === 'suspend' && `Suspend ${person.name}?`}
              {pending.kind === 'reactivate' && `Reactivate ${person.name}?`}
              {pending.kind === 'remove' && `Remove ${person.name}?`}
              {pending.kind === 'mfa' && `Reset two-factor sign-in for ${person.name}?`}
            </h3>
            <p className="muted">
              {pending.kind === 'suspend' && 'They cannot sign in until reactivated. Their sessions end now.'}
              {pending.kind === 'reactivate' && 'They can sign in again.'}
              {pending.kind === 'remove' && 'They can no longer sign in. This cannot be undone from this screen.'}
              {pending.kind === 'mfa' && 'They will need to set up two-factor sign-in again. Their sessions end now.'}
            </p>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" type="button" onClick={() => setPending(null)}>Cancel</button>
              <button className={`btn ${pending.kind === 'remove' ? 'btn-danger' : 'btn-primary'}`} type="button" disabled={busy} onClick={confirmAndRun}>
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
