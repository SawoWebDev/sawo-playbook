'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage, plural } from '@/lib/format';
import { hasPermission } from '@/lib/permissions';
import { UserManagementTabs } from '@/components/UserManagementTabs';

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

interface UserRow {
  id: string;
  name: string;
  email: string;
  status: string;
}

type Confirm = { kind: 'delete' } | { kind: 'remove'; member: Member } | null;

/**
 * Groups scope approval routing. The server decides every refusal (last group, pending routing); this screen shows the
 * server's own message and never re-implements those rules.
 */
export default function GroupsPage() {
  const { user } = useAuth();
  const allowed = hasPermission(user, 'groups.manage');
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<GroupDetail | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [newName, setNewName] = useState('');
  const [renameTo, setRenameTo] = useState('');
  const [addIds, setAddIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState(false);

  const loadGroups = useCallback(async () => {
    setGroups(await api<GroupRow[]>('/groups'));
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    const d = await api<GroupDetail>(`/groups/${id}`);
    setDetail(d);
    setRenameTo(d.name);
  }, []);

  useEffect(() => {
    if (!allowed) return;
    loadGroups().catch((e) => setError(errorMessage(e)));
    api<UserRow[]>('/users').then(setUsers).catch(() => undefined);
  }, [allowed, loadGroups]);

  useEffect(() => {
    setAddIds([]);
    if (!selected) {
      setDetail(null);
      return;
    }
    loadDetail(selected).catch((e) => setError(errorMessage(e)));
  }, [selected, loadDetail]);

  /** Runs one change, shows the server's result, then reloads what is on screen. */
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      await loadGroups();
      if (selected) await loadDetail(selected).catch(() => setSelected(null));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!allowed) {
    return (
      <>
        <h1>Groups</h1>
        <p className="muted">Only Admins can manage groups.</p>
      </>
    );
  }

  const memberIds = new Set(detail?.members.map((m) => m.id) ?? []);
  const candidates = users.filter((u) => !memberIds.has(u.id) && u.status !== 'removed');

  return (
    <>
      <h1>User Management</h1>
      <UserManagementTabs />
      <h2>Groups</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Groups decide who reviews a submission: a submission is routed to the approvers in the submitter&apos;s groups. Content does not belong to a group.
        The server refuses a deletion that would leave someone without a group, or that would break pending approval work, and says why.
      </p>
      {error && <div className="error" role="alert">{error}</div>}
      {notice && <div className="success">{notice}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 300px) 1fr', gap: 16, alignItems: 'start' }}>
        <section className="card" aria-label="Group list">
          <form
            className="row"
            style={{ marginBottom: 12 }}
            onSubmit={(e) => {
              e.preventDefault();
              const name = newName.trim();
              if (!name) return;
              run(() => api('/groups', { method: 'POST', body: { name } }), `Created ${name}.`).then(() => setNewName(''));
            }}
          >
            <input aria-label="New group name" placeholder="New group name" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={100} style={{ flex: 1 }} />
            <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !newName.trim()}>Create</button>
          </form>
          {groups.length === 0 && <p className="muted">No groups yet. Create one above.</p>}
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {groups.map((g) => (
              <li key={g.id} style={{ marginBottom: 4 }}>
                <button
                  type="button"
                  className={`btn btn-sm ${selected === g.id ? 'btn-primary' : ''}`}
                  style={{ width: '100%', textAlign: 'left', display: 'flex', justifyContent: 'space-between' }}
                  aria-pressed={selected === g.id}
                  onClick={() => setSelected(g.id)}
                >
                  <span>{g.name}</span>
                  <span className="muted">{plural(g.memberCount, 'member')}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="card" aria-label="Group detail">
          {!selected || !detail ? (
            <p className="muted">Select a group to see its members, rename it, or delete it.</p>
          ) : (
            <>
              <form
                className="row"
                style={{ marginBottom: 14 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = renameTo.trim();
                  if (name && name !== detail.name) run(() => api(`/groups/${detail.id}`, { method: 'PATCH', body: { name } }), 'Group renamed.');
                }}
              >
                <input aria-label="Group name" value={renameTo} onChange={(e) => setRenameTo(e.target.value)} maxLength={100} style={{ flex: 1 }} />
                <button className="btn btn-sm" type="submit" disabled={busy || !renameTo.trim() || renameTo.trim() === detail.name}>Rename</button>
                <button className="btn btn-danger btn-sm" type="button" disabled={busy} onClick={() => setConfirm({ kind: 'delete' })}>Delete group</button>
              </form>

              <h3 style={{ marginBottom: 6 }}>Members ({detail.members.length})</h3>
              {detail.members.length === 0 ? (
                <p className="muted">No members. Add people below.</p>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Email</th>
                      <th>Role</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {detail.members.map((m) => (
                      <tr key={m.id}>
                        <td>{m.name}</td>
                        <td>{m.email}</td>
                        <td>{m.orgRole}</td>
                        <td>{m.status}</td>
                        <td style={{ textAlign: 'right' }}>
                          <button className="btn btn-sm" type="button" disabled={busy} onClick={() => setConfirm({ kind: 'remove', member: m })}>
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <h3 style={{ margin: '16px 0 6px' }}>Add members</h3>
              {candidates.length === 0 ? (
                <p className="muted">Everyone in this organisation is already a member.</p>
              ) : (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (addIds.length) run(() => api(`/groups/${detail.id}/members`, { method: 'POST', body: { userIds: addIds } }), `Added ${plural(addIds.length, 'member')}.`);
                  }}
                >
                  <select multiple aria-label="People to add" value={addIds} onChange={(e) => setAddIds(Array.from(e.target.selectedOptions, (o) => o.value))} style={{ width: '100%', minHeight: 120 }}>
                    {candidates.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name} — {u.email}
                      </option>
                    ))}
                  </select>
                  <div className="row" style={{ marginTop: 8 }}>
                    <span className="muted">Hold Ctrl or Cmd to select several.</span>
                    <div className="spacer" />
                    <button className="btn btn-primary btn-sm" type="submit" disabled={busy || addIds.length === 0}>Add to group</button>
                  </div>
                </form>
              )}
            </>
          )}
        </section>
      </div>

      {confirm && detail && (
        <div className="dialog-backdrop" role="presentation" onClick={() => setConfirm(null)}>
          <div className="card dialog" role="dialog" aria-modal="true" aria-label="Confirm" onClick={(e) => e.stopPropagation()}>
            {confirm.kind === 'delete' ? (
              <>
                <h3>Delete {detail.name}?</h3>
                <p className="muted">Its members lose this group. The server refuses the deletion if it would leave someone without a group, or if pending approvals are routed to it.</p>
              </>
            ) : (
              <>
                <h3>Remove {confirm.member.name} from {detail.name}?</h3>
                <p className="muted">If this is their only group, the server refuses the change.</p>
              </>
            )}
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" type="button" onClick={() => setConfirm(null)}>Cancel</button>
              <button
                className="btn btn-danger"
                type="button"
                disabled={busy}
                onClick={() => {
                  const c = confirm;
                  setConfirm(null);
                  if (c.kind === 'delete') run(() => api(`/groups/${detail.id}`, { method: 'DELETE' }), 'Group deleted.').then(() => setSelected(null));
                  else run(() => api(`/groups/${detail.id}/members/${c.member.id}`, { method: 'DELETE' }), 'Member removed.');
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
