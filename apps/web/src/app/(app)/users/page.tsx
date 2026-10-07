'use client';

import { useToast } from '@/components/feedback/Toast';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Role } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage, fmtDate, plural } from '@/lib/format';
import { ASSIGNABLE_ROLES, hasPermission, roleLabel } from '@/lib/permissions';
import { UserManagementTabs } from '@/components/UserManagementTabs';
import { Avatar, ROLE_ICON } from '@/components/users/Avatar';
import { CreateUserDialog } from '@/components/users/CreateUserDialog';
import { InviteDialog, type GroupOption } from '@/components/users/InviteDialog';
import { ROLE_PILL_CLASS, STATUS_BADGE, STATUS_LABEL, type UserRow } from '@/components/users/shared';
import { permissionLabel } from '@/lib/permission-labels';

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
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<'' | Role>('');
  const [groupFilter, setGroupFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | UserRow['status']>('');
  const [showInvite, setShowInvite] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showRemoved, setShowRemoved] = useState(false);
  const [busy, setBusy] = useState(false);

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

  /** People counted in the tiles and role chips: everyone except removed accounts. */
  const current = useMemo(() => (users ?? []).filter((u) => u.status !== 'removed'), [users]);

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

  /** Changes one person's role from the list. The server enforces who may do it and says why when it refuses. */
  const changeRole = async (u: UserRow, role: Role) => {
    if (role === u.orgRole) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/users/${u.id}/role`, { method: 'PATCH', body: { role } });
      toast.success(`${u.name} is now ${roleLabel(role)}. They are signed out everywhere.`);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (inv: InvitationRow) => {
    setError(null);
    try {
      await api(`/users/invitations/${inv.id}`, { method: 'DELETE' });
      toast.success(`Invitation for ${inv.email} revoked.`);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  if (!canManage) {
    return (
      <>
        <UserManagementTabs />
        <p className="muted">Only Admins can manage users.</p>
      </>
    );
  }

  const active = current.filter((u) => u.status === 'active').length;
  const notReady = current.filter((u) => !u.approvalReadiness.ready).length;
  const filtered = !!(query || roleFilter || groupFilter || statusFilter);

  return (
    <>
      <UserManagementTabs />

      <div className="grp-head">
        <div>
          <h2 style={{ margin: 0 }}>Users</h2>
          <p className="muted grp-lead">Invite people, set their role and groups. Role changes sign the person out everywhere.</p>
        </div>
        <div className="grp-head-actions">
          <div className="grp-search">
            <i className="fa-solid fa-magnifying-glass" aria-hidden />
            <input aria-label="Search people" placeholder="Search name or email" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <button className="btn" type="button" onClick={() => setShowCreate(true)}>
            <i className="fa-solid fa-user-plus" aria-hidden /> Create user
          </button>
          <button className="btn btn-primary" type="button" onClick={() => setShowInvite(true)}>
            <i className="fa-solid fa-envelope" aria-hidden /> Invite people
          </button>
        </div>
      </div>

      {users && (
        <div className="grp-stats um-stats">
          <div className="grp-stat">
            <span className="grp-stat-value">{current.length}</span>
            <span className="grp-stat-label">People</span>
          </div>
          <div className="grp-stat">
            <span className="grp-stat-value">{active}</span>
            <span className="grp-stat-label">Active</span>
          </div>
          <div className="grp-stat">
            <span className="grp-stat-value">{invites.length}</span>
            <span className="grp-stat-label">Pending invitations</span>
          </div>
          <div className={`grp-stat${notReady ? ' grp-stat-warn' : ''}`}>
            <span className="grp-stat-value">{notReady}</span>
            <span className="grp-stat-label">Not ready for approvals</span>
          </div>
        </div>
      )}

      {error && <div className="error" role="alert">{error}</div>}

      <div className="um-filters" role="search">
        <div className="um-role-chips" role="group" aria-label="Filter by role">
          <button type="button" className={`um-role-chip${roleFilter === '' ? ' is-on' : ''}`} aria-pressed={roleFilter === ''} onClick={() => setRoleFilter('')}>
            All <span>{current.length}</span>
          </button>
          {ASSIGNABLE_ROLES.map((r) => (
            <button key={r} type="button" className={`um-role-chip${roleFilter === r ? ' is-on' : ''}`} aria-pressed={roleFilter === r} onClick={() => setRoleFilter(roleFilter === r ? '' : r)}>
              <i className={`fa-solid ${ROLE_ICON[r] ?? 'fa-user-tag'}`} aria-hidden /> {roleLabel(r)} <span>{current.filter((u) => u.orgRole === r).length}</span>
            </button>
          ))}
        </div>
        <div className="um-filter-selects">
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
          <label className="filter-check">
            <input type="checkbox" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} />
            Show removed
          </label>
          {filtered && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setQuery('');
                setRoleFilter('');
                setGroupFilter('');
                setStatusFilter('');
              }}
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {users === null && !error && <p className="muted" role="status">Loading people…</p>}

      {users !== null && (
        <div className="um-card">
          {visible.length === 0 ? (
            <div className="um-empty">
              <i className="fa-solid fa-users" aria-hidden />
              <p>{users.length === 0 ? 'No one in this organisation yet. Invite people to get started.' : 'No one matches these filters.'}</p>
            </div>
          ) : (
            <div className="um-table-wrap">
              <table className="um-table">
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Role</th>
                    <th>Groups</th>
                    <th>Status</th>
                    <th>Approvals</th>
                    <th>Last sign-in</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((u) => (
                    <tr key={u.id} className={u.status === 'removed' ? 'is-removed' : ''}>
                      <td>
                        <div className="um-person">
                          <Avatar name={u.name} size={34} />
                          <div className="grp-member-info">
                            <span className="grp-member-name">
                              {u.name}
                              {u.id === me?.id && <span className="grp-chip">You</span>}
                              {u.mfaEnabled && <i className="fa-solid fa-shield-halved um-mfa" title="Two-factor sign-in is on" aria-label="Two-factor sign-in is on" />}
                              {u.extraPermissions?.length > 0 && (
                                <span className="badge badge-blue" title={u.extraPermissions.map(permissionLabel).join('\n')}>
                                  <i className="fa-solid fa-user-shield" aria-hidden /> Special access
                                </span>
                              )}
                            </span>
                            <span className="muted grp-member-email">{u.email}</span>
                          </div>
                        </div>
                      </td>
                      <td>
                        <select
                          className={`role-pill role-pill-select ${ROLE_PILL_CLASS[u.orgRole] ?? ''}`}
                          aria-label={`Role for ${u.name}`}
                          value={u.orgRole}
                          disabled={busy || u.status === 'removed'}
                          onChange={(e) => void changeRole(u, e.target.value as Role)}
                        >
                          {ASSIGNABLE_ROLES.map((r) => (
                            <option key={r} value={r}>{roleLabel(r)}</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        {u.groups.length === 0 ? (
                          <span className="muted">{u.orgRole === 'ADMIN' ? 'All (Admin)' : 'None'}</span>
                        ) : (
                          <div className="um-groups" title={u.groups.map((g) => g.name).join(', ')}>
                            {u.groups.slice(0, 2).map((g) => (
                              <span key={g.id} className="grp-chip">{g.name}</span>
                            ))}
                            {u.groups.length > 2 && <span className="grp-chip um-chip-more">+{u.groups.length - 2}</span>}
                          </div>
                        )}
                      </td>
                      <td><span className={`badge ${STATUS_BADGE[u.status]}`}>{STATUS_LABEL[u.status]}</span></td>
                      <td>
                        {u.approvalReadiness.ready ? (
                          <span className="um-ready"><i className="fa-solid fa-circle-check" aria-hidden /> Ready</span>
                        ) : (
                          <span className="um-not-ready" title={u.approvalReadiness.issue ?? undefined}>
                            <i className="fa-solid fa-triangle-exclamation" aria-hidden /> {u.approvalReadiness.issue ?? 'Not ready'}
                          </span>
                        )}
                      </td>
                      <td className="muted um-nowrap">{u.lastLoginAt ? fmtDate(u.lastLoginAt) : 'Never'}</td>
                      <td className="um-actions">
                        <Link className="grp-icon-btn" href={`/users/${u.id}`} title={`Edit ${u.name}`} aria-label={`Edit ${u.name}`}>
                          <i className="fa-solid fa-pen" aria-hidden />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {visible.length > 0 && (
            <div className="um-card-foot muted">
              Showing {plural(visible.length, 'person', 'people')}
              {visible.length !== current.length ? ` of ${current.length}` : ''}
            </div>
          )}
        </div>
      )}

      <section aria-label="Pending invitations" className="um-invites">
        <h3 className="grp-section-title">Pending invitations ({invites.length})</h3>
        {invites.length === 0 ? (
          <p className="muted">No pending invitations.</p>
        ) : (
          <div className="um-invite-grid">
            {invites.map((i) => (
              <div key={i.id} className="um-invite">
                <span className="um-invite-icon"><i className="fa-solid fa-envelope" aria-hidden /></span>
                <div className="grp-member-info">
                  <span className="grp-member-name" title={i.email}>{i.email}</span>
                  <span className="muted grp-member-email">
                    {roleLabel(i.orgRole)} · expires {fmtDate(i.expiresAt)}
                  </span>
                </div>
                <button className="btn btn-sm" type="button" onClick={() => revoke(i)}>Revoke</button>
              </div>
            ))}
          </div>
        )}
      </section>

      {showCreate && (
        <CreateUserDialog
          groups={groups}
          onClose={() => setShowCreate(false)}
          onDone={(message) => {
            toast.success(message);
            load().catch((e) => setError(errorMessage(e)));
          }}
        />
      )}

      {showInvite && (
        <InviteDialog
          groups={groups}
          onClose={() => setShowInvite(false)}
          onDone={(message) => {
            toast.success(message);
            load().catch((e) => setError(errorMessage(e)));
          }}
        />
      )}
    </>
  );
}
