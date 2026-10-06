'use client';

import { useToast } from '@/components/feedback/Toast';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Role } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage, plural } from '@/lib/format';
import { ASSIGNABLE_ROLES, hasPermission, roleLabel } from '@/lib/permissions';
import { UserManagementTabs } from '@/components/UserManagementTabs';
import { Avatar } from '@/components/users/Avatar';
import { STATUS_BADGE, STATUS_LABEL, type UserRow } from '@/components/users/shared';

interface GroupRow {
  id: string;
  name: string;
  memberCount: number;
}

interface Member {
  id: string;
  name: string;
  email: string;
  orgRole: string;
  status: string;
}

interface GroupDetail {
  id: string;
  name: string;
  members: Member[];
}

type Confirm = { kind: 'delete'; group: GroupRow } | { kind: 'remove'; group: GroupDetail; member: Member } | null;

/** Roles shown in each card's breakdown, in this order. Counts come from the users list, never from a guess. */
const BREAKDOWN: Role[] = ['APPROVER', 'PRE_APPROVER', 'EDITOR', 'OPERATOR', 'ADMIN'];

const statusLabel = (s: string) => STATUS_LABEL[s as UserRow['status']] ?? s;
const statusBadge = (s: string) => STATUS_BADGE[s as UserRow['status']] ?? '';

/**
 * Groups scope approval routing. The server decides every refusal (last group, pending routing); this screen shows the
 * server's own message and never re-implements those rules.
 */
export default function GroupsPage() {
  const { user } = useAuth();
  const allowed = hasPermission(user, 'groups.manage');
  const [groups, setGroups] = useState<GroupRow[] | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<GroupDetail | null>(null);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState('');
  const [addQuery, setAddQuery] = useState('');
  const [addIds, setAddIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState(false);

  const loadGroups = useCallback(async () => {
    setGroups(await api<GroupRow[]>('/groups'));
  }, []);

  const loadUsers = useCallback(async () => {
    setUsers(await api<UserRow[]>('/users'));
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    setDetail(await api<GroupDetail>(`/groups/${id}`));
  }, []);

  useEffect(() => {
    if (!allowed) return;
    loadGroups().catch((e) => setError(errorMessage(e)));
    loadUsers().catch(() => undefined);
  }, [allowed, loadGroups, loadUsers]);

  useEffect(() => {
    setAddIds([]);
    setAddQuery('');
    if (!selected) {
      setDetail(null);
      return;
    }
    loadDetail(selected).catch((e) => setError(errorMessage(e)));
  }, [selected, loadDetail]);

  // Close the panel with Escape.
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSelected(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  /** Runs one change, shows the server's result, then reloads what is on screen. */
  const run = async (fn: () => Promise<unknown>, done: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      toast.success(done);
      await Promise.all([loadGroups(), loadUsers()]);
      if (selected) await loadDetail(selected).catch(() => setSelected(null));
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  /** Members of each group, from the users list (which carries every person's groups). Removed people are left out. */
  const membersByGroup = useMemo(() => {
    const map = new Map<string, UserRow[]>();
    for (const u of users) {
      if (u.status === 'removed') continue;
      for (const g of u.groups) map.set(g.id, [...(map.get(g.id) ?? []), u]);
    }
    return map;
  }, [users]);

  const visibleGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (groups ?? []).filter((g) => !q || g.name.toLowerCase().includes(q));
  }, [groups, query]);

  if (!allowed) {
    return (
      <>
        <UserManagementTabs />
        <p className="muted">Only Admins can manage groups.</p>
      </>
    );
  }

  const createGroup = async () => {
    const name = newName.trim();
    if (!name) return;
    if (await run(() => api('/groups', { method: 'POST', body: { name } }), `Created ${name}.`)) {
      setNewName('');
      setCreating(false);
    }
  };

  const saveRename = async (g: GroupRow) => {
    const name = renameTo.trim();
    if (!name || name === g.name) {
      setRenaming(null);
      return;
    }
    if (await run(() => api(`/groups/${g.id}`, { method: 'PATCH', body: { name } }), 'Group renamed.')) setRenaming(null);
  };

  const changeRole = (m: Member, role: Role) => {
    if (role === m.orgRole) return;
    void run(() => api(`/users/${m.id}/role`, { method: 'PATCH', body: { role } }), `${m.name} is now ${roleLabel(role)}. They are signed out everywhere.`);
  };

  const memberIds = new Set(detail?.members.map((m) => m.id) ?? []);
  const aq = addQuery.trim().toLowerCase();
  const candidates = users.filter((u) => !memberIds.has(u.id) && u.status !== 'removed' && (!aq || `${u.name} ${u.email}`.toLowerCase().includes(aq)));
  const totalPeople = users.filter((u) => u.status !== 'removed').length;
  const ungrouped = users.filter((u) => u.status !== 'removed' && u.orgRole !== 'ADMIN' && u.groups.length === 0).length;

  return (
    <>
      <UserManagementTabs />

      <div className="grp-head">
        <div>
          <h2 style={{ margin: 0 }}>Groups</h2>
          <p className="muted grp-lead">
            A submission is routed to the approvers in the submitter&apos;s groups. Content does not belong to a group.
          </p>
        </div>
        <div className="grp-head-actions">
          <div className="grp-search">
            <i className="fa-solid fa-magnifying-glass" aria-hidden />
            <input aria-label="Search groups" placeholder="Search groups" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <button className="btn btn-primary" type="button" onClick={() => setCreating(true)} disabled={creating}>
            <i className="fa-solid fa-plus" aria-hidden /> New group
          </button>
        </div>
      </div>

      {groups && (
        <div className="grp-stats">
          <div className="grp-stat">
            <span className="grp-stat-value">{groups.length}</span>
            <span className="grp-stat-label">{groups.length === 1 ? 'Group' : 'Groups'}</span>
          </div>
          <div className="grp-stat">
            <span className="grp-stat-value">{totalPeople}</span>
            <span className="grp-stat-label">People</span>
          </div>
          <div className={`grp-stat${ungrouped ? ' grp-stat-warn' : ''}`}>
            <span className="grp-stat-value">{ungrouped}</span>
            <span className="grp-stat-label">Without a group</span>
          </div>
        </div>
      )}

      {error && <div className="error" role="alert">{error}</div>}

      {groups === null && !error && <p className="muted" role="status">Loading groups…</p>}

      <div className="grp-grid">
        {creating && (
          <form
            className="grp-card grp-card-new"
            onSubmit={(e) => {
              e.preventDefault();
              void createGroup();
            }}
          >
            <div className="grp-card-top">
              <span className="grp-icon"><i className="fa-solid fa-user-group" aria-hidden /></span>
              <input autoFocus aria-label="New group name" placeholder="Group name" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={100} />
            </div>
            <p className="muted grp-hint">Add members after creating the group.</p>
            <div className="grp-card-foot">
              <button className="btn btn-sm" type="button" onClick={() => { setCreating(false); setNewName(''); }}>Cancel</button>
              <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !newName.trim()}>Create group</button>
            </div>
          </form>
        )}

        {visibleGroups.map((g) => {
          const members = membersByGroup.get(g.id) ?? [];
          const counts = BREAKDOWN.map((r) => [r, members.filter((m) => m.orgRole === r).length] as const).filter(([, n]) => n > 0);
          return (
            <article key={g.id} className={`grp-card${selected === g.id ? ' is-selected' : ''}`}>
              <div className="grp-card-top">
                <span className="grp-icon"><i className="fa-solid fa-user-group" aria-hidden /></span>
                {renaming === g.id ? (
                  <input
                    autoFocus
                    aria-label={`New name for ${g.name}`}
                    value={renameTo}
                    maxLength={100}
                    disabled={busy}
                    onChange={(e) => setRenameTo(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void saveRename(g);
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                    onBlur={() => void saveRename(g)}
                  />
                ) : (
                  <div className="grp-title">
                    <h3 title={g.name}>{g.name}</h3>
                    <span className="muted">{plural(g.memberCount, 'member')}</span>
                  </div>
                )}
                <div className="grp-card-tools">
                  <button
                    type="button"
                    className="grp-icon-btn"
                    title="Rename"
                    aria-label={`Rename ${g.name}`}
                    onClick={() => {
                      setRenaming(g.id);
                      setRenameTo(g.name);
                    }}
                  >
                    <i className="fa-solid fa-pen" aria-hidden />
                  </button>
                  <button type="button" className="grp-icon-btn danger" title="Delete" aria-label={`Delete ${g.name}`} onClick={() => setConfirm({ kind: 'delete', group: g })}>
                    <i className="fa-solid fa-trash" aria-hidden />
                  </button>
                </div>
              </div>

              <div className="grp-roles">
                {counts.length === 0 ? (
                  <span className="muted">No members yet</span>
                ) : (
                  counts.map(([r, n]) => (
                    <span key={r} className="grp-chip">
                      {n} {roleLabel(r)}
                    </span>
                  ))
                )}
              </div>

              <div className="grp-card-foot">
                <div className="grp-avatars" aria-label={`${g.memberCount} members`}>
                  {members.slice(0, 5).map((m) => (
                    <Avatar key={m.id} name={m.name} />
                  ))}
                  {members.length > 5 && <span className="grp-avatar grp-avatar-more">+{members.length - 5}</span>}
                </div>
                <button className="btn btn-sm" type="button" onClick={() => setSelected(g.id)}>
                  <i className="fa-solid fa-users-gear" aria-hidden /> Manage
                </button>
              </div>
            </article>
          );
        })}
      </div>

      {groups && groups.length === 0 && !creating && (
        <div className="grp-empty">
          <span className="grp-icon grp-icon-lg"><i className="fa-solid fa-user-group" aria-hidden /></span>
          <h3>No groups yet</h3>
          <p className="muted">Create a group, then add people so their submissions reach the right approvers.</p>
          <button className="btn btn-primary" type="button" onClick={() => setCreating(true)}>
            <i className="fa-solid fa-plus" aria-hidden /> New group
          </button>
        </div>
      )}
      {groups && groups.length > 0 && visibleGroups.length === 0 && <p className="muted">No groups match “{query}”.</p>}

      {/* Members panel */}
      {selected && (
        <div className="grp-panel-backdrop" onClick={() => setSelected(null)}>
          <aside className="grp-panel" role="dialog" aria-modal="true" aria-label="Group members" onClick={(e) => e.stopPropagation()}>
            <header className="grp-panel-head">
              <div className="grp-title">
                <h3>{detail?.name ?? 'Loading…'}</h3>
                {detail && <span className="muted">{plural(detail.members.length, 'member')}</span>}
              </div>
              <button type="button" className="grp-icon-btn" aria-label="Close" onClick={() => setSelected(null)}>
                <i className="fa-solid fa-xmark" aria-hidden />
              </button>
            </header>

            {detail && (
              <div className="grp-panel-body">
                <h4 className="grp-section-title">Members</h4>
                {detail.members.length === 0 ? (
                  <p className="muted">No members yet. Add people below.</p>
                ) : (
                  <ul className="grp-member-list">
                    {detail.members.map((m) => (
                      <li key={m.id} className="grp-member">
                        <Avatar name={m.name} size={34} />
                        <div className="grp-member-info">
                          <div className="grp-member-name">
                            {m.name} {m.status !== 'active' && <span className={`badge ${statusBadge(m.status)}`}>{statusLabel(m.status)}</span>}
                          </div>
                          <div className="muted grp-member-email">{m.email}</div>
                        </div>
                        <select
                          className="inline-select"
                          aria-label={`Role for ${m.name}`}
                          value={m.orgRole}
                          disabled={busy}
                          onChange={(e) => changeRole(m, e.target.value as Role)}
                        >
                          {ASSIGNABLE_ROLES.map((r) => (
                            <option key={r} value={r}>{roleLabel(r)}</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="grp-icon-btn danger"
                          title="Remove from group"
                          aria-label={`Remove ${m.name} from ${detail.name}`}
                          disabled={busy}
                          onClick={() => setConfirm({ kind: 'remove', group: detail, member: m })}
                        >
                          <i className="fa-solid fa-user-minus" aria-hidden />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                <h4 className="grp-section-title">Add people</h4>
                <div className="grp-search grp-search-full">
                  <i className="fa-solid fa-magnifying-glass" aria-hidden />
                  <input aria-label="Search people to add" placeholder="Search name or email" value={addQuery} onChange={(e) => setAddQuery(e.target.value)} />
                </div>
                {candidates.length === 0 ? (
                  <p className="muted">{aq ? 'No one matches that search.' : 'Everyone in this organisation is already a member.'}</p>
                ) : (
                  <ul className="grp-pick-list">
                    {candidates.map((u) => {
                      const checked = addIds.includes(u.id);
                      return (
                        <li key={u.id}>
                          <label className={`grp-pick${checked ? ' is-checked' : ''}`}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => setAddIds((ids) => (checked ? ids.filter((x) => x !== u.id) : [...ids, u.id]))}
                            />
                            <Avatar name={u.name} size={28} />
                            <span className="grp-member-info">
                              <span className="grp-member-name">{u.name}</span>
                              <span className="muted grp-member-email">{u.email}</span>
                            </span>
                            <span className="grp-chip">{roleLabel(u.orgRole)}</span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}

            {detail && (
              <footer className="grp-panel-foot">
                <span className="muted">{addIds.length ? `${plural(addIds.length, 'person', 'people')} selected` : 'Select people to add'}</span>
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={busy || addIds.length === 0}
                  onClick={async () => {
                    if (await run(() => api(`/groups/${detail.id}/members`, { method: 'POST', body: { userIds: addIds } }), `Added ${plural(addIds.length, 'member')} to ${detail.name}.`)) setAddIds([]);
                  }}
                >
                  Add to group
                </button>
              </footer>
            )}
          </aside>
        </div>
      )}

      {confirm && (
        <div className="dialog-backdrop" role="presentation" onClick={() => setConfirm(null)} style={{ zIndex: 700 }}>
          <div className="card dialog" role="dialog" aria-modal="true" aria-label="Confirm" onClick={(e) => e.stopPropagation()}>
            {confirm.kind === 'delete' ? (
              <>
                <h3>Delete {confirm.group.name}?</h3>
                <p className="muted">Its members lose this group. The server refuses the deletion if it would leave someone without a group, or if pending approvals are routed to it.</p>
              </>
            ) : (
              <>
                <h3>Remove {confirm.member.name} from {confirm.group.name}?</h3>
                <p className="muted">If this is their only group, the server refuses the change.</p>
              </>
            )}
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" type="button" onClick={() => setConfirm(null)}>Cancel</button>
              <button
                className="btn btn-danger"
                type="button"
                disabled={busy}
                onClick={async () => {
                  const c = confirm;
                  setConfirm(null);
                  if (c.kind === 'delete') {
                    if (await run(() => api(`/groups/${c.group.id}`, { method: 'DELETE' }), `${c.group.name} deleted.`) && selected === c.group.id) setSelected(null);
                  } else {
                    await run(() => api(`/groups/${c.group.id}/members/${c.member.id}`, { method: 'DELETE' }), `${c.member.name} removed from ${c.group.name}.`);
                  }
                }}
              >
                {confirm.kind === 'delete' ? 'Delete group' : 'Remove member'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
