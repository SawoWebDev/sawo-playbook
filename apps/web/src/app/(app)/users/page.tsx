'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Role } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage, fmtDate, plural } from '@/lib/format';
import { ASSIGNABLE_ROLES, hasPermission, roleLabel } from '@/lib/permissions';
import { UserManagementTabs } from '@/components/UserManagementTabs';
import { InviteDialog, type GroupOption } from '@/components/users/InviteDialog';
import { STATUS_BADGE, STATUS_LABEL, type UserRow } from '@/components/users/shared';

interface InvitationRow {
  id: string;
  email: string;
  orgRole: Role;
  expiresAt: string;
}

/**
 * Users list. Search and filters run over the rows the API returned for this organisation; the API has no paging and
 * the organisation's user list is small enough to hold in memory. Visibility uses server permissions only.
 */
export default function UsersPage() {
  const { user: me } = useAuth();
  const canManage = hasPermission(me, 'users.manage');
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [invites, setInvites] = useState<InvitationRow[]>([]);
  const [groups, setGroups] = useState<GroupOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<'' | Role>('');
  const [groupFilter, setGroupFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | UserRow['status']>('');
  const [showInvite, setShowInvite] = useState(false);
  const [showRemoved, setShowRemoved] = useState(false);

  const load = useCallback(async () => {
    const [list, pending] = await Promise.all([api<UserRow[]>('/users'), api<InvitationRow[]>('/users/invitations')]);
    setUsers(list);
    setInvites(pending);
  }, []);

  useEffect(() => {
    if (!canManage) return;
    load().catch((e) => setError(errorMessage(e)));
    api<GroupOption[]>('/groups').then(setGroups).catch(() => undefined);
  }, [canManage, load]);

  const visible = useMemo(() => {
    if (!users) return [];
    const q = query.trim().toLowerCase();
    return users.filter((u) => {
      if (!showRemoved && u.status === 'removed' && statusFilter !== 'removed') return false;
      if (statusFilter && u.status !== statusFilter) return false;
      if (roleFilter && u.orgRole !== roleFilter) return false;
      if (groupFilter && !u.groups.some((g) => g.id === groupFilter)) return false;
      if (q && !`${u.name} ${u.email}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [users, query, roleFilter, groupFilter, statusFilter, showRemoved]);

  const revoke = async (inv: InvitationRow) => {
    setError(null);
    setNotice(null);
    try {
      await api(`/users/invitations/${inv.id}`, { method: 'DELETE' });
      setNotice(`Invitation for ${inv.email} revoked.`);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
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
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Users</h2>
        <div className="spacer" />
        <button className="btn btn-primary btn-sm" type="button" onClick={() => setShowInvite(true)}>
          Invite people
        </button>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {notice && <div className="success">{notice}</div>}

      <div className="row" style={{ marginBottom: 12 }} role="search">
        <input aria-label="Search people" placeholder="Search name or email" value={query} onChange={(e) => setQuery(e.target.value)} style={{ minWidth: 220 }} />
        <select aria-label="Filter by role" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value as '' | Role)}>
          <option value="">All roles</option>
          {ASSIGNABLE_ROLES.map((r) => (
            <option key={r} value={r}>{roleLabel(r)}</option>
          ))}
        </select>
        <select aria-label="Filter by group" value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}>
          <option value="">All groups</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
        <select aria-label="Filter by status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as '' | UserRow['status'])}>
          <option value="">Any status</option>
          {(Object.keys(STATUS_LABEL) as UserRow['status'][]).map((s) => (
            <option key={s} value={s}>{STATUS_LABEL[s]}</option>
          ))}
        </select>
        <label className="row" style={{ fontWeight: 400, margin: 0 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} />
          Show removed
        </label>
      </div>

      {users === null && !error && <p className="muted" role="status">Loading people…</p>}
      {users !== null && visible.length === 0 && (
        <p className="muted">{users.length === 0 ? 'No one in this organisation yet. Invite people to get started.' : 'No one matches these filters.'}</p>
      )}

      {users !== null && visible.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Groups</th>
              <th>Status</th>
              <th>Approvals</th>
              <th>MFA</th>
              <th>Last sign-in</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visible.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td className="muted">{u.email}</td>
                <td><span className="badge badge-blue">{roleLabel(u.orgRole)}</span></td>
                <td>
                  {u.groups.length === 0 ? (
                    <span className="muted">{u.orgRole === 'ADMIN' ? 'No groups (Admin)' : 'None'}</span>
                  ) : (
                    u.groups.map((g) => (
                      <span key={g.id} className="badge" style={{ marginRight: 4, background: 'var(--surface-2, #f1f1f1)' }}>{g.name}</span>
                    ))
                  )}
                </td>
                <td><span className={`badge ${STATUS_BADGE[u.status]}`}>{STATUS_LABEL[u.status]}</span></td>
                <td>
                  {u.approvalReadiness.ready ? (
                    <span className="badge badge-green">Ready</span>
                  ) : (
                    <span className="badge badge-amber" title={u.approvalReadiness.issue ?? undefined}>{u.approvalReadiness.issue ?? "Not ready"}</span>
                  )}
                </td>
                <td>{u.mfaEnabled ? 'On' : <span className="muted">Off</span>}</td>
                <td className="muted">{u.lastLoginAt ? fmtDate(u.lastLoginAt) : 'Never'}</td>
                <td style={{ textAlign: 'right' }}>
                  <Link className="btn btn-sm" href={`/users/${u.id}`}>Open</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <section aria-label="Pending invitations" style={{ marginTop: 28 }}>
        <h3>Pending invitations ({plural(invites.length, 'invitation')})</h3>
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
                  <td>{roleLabel(i.orgRole)}</td>
                  <td className="muted">{fmtDate(i.expiresAt)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn btn-sm" type="button" onClick={() => revoke(i)}>Revoke</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {showInvite && (
        <InviteDialog
          groups={groups}
          onClose={() => setShowInvite(false)}
          onDone={(message) => {
            setNotice(message);
            load().catch((e) => setError(errorMessage(e)));
          }}
        />
      )}
    </>
  );
}
