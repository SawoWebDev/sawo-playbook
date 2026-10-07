'use client';

import { useToast } from '@/components/feedback/Toast';
import { Loading } from '@/components/feedback/Loading';
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
import { actionLabel, areaName, permissionLabel } from '@/lib/permission-labels';

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
  /** Permissions granted to this person on top of their role. */
  extraPermissions: string[];
  approvalReadiness: { ready: boolean; issue: string | null };
}

/** The part of GET /roles this screen needs: each role's effective permissions and the keys an Admin may grant. */
interface RolesMatrix {
  roles: { role: Role; permissions: string[] }[];
  configurable: string[];
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
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('OPERATOR');
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [extras, setExtras] = useState<string[]>([]);
  const [matrix, setMatrix] = useState<RolesMatrix | null>(null);

  const load = useCallback(async () => {
    const d = await api<UserDetail>(`/users/${id}`);
    setPerson(d);
    setName(d.name);
    setEmail(d.email);
    setRole(d.orgRole);
    setGroupIds(d.groups.map((g) => g.id));
    setExtras(d.extraPermissions ?? []);
  }, [id]);

  useEffect(() => {
    if (!canManage) return;
    load().catch((e) => setError(errorMessage(e)));
    if (canGroups) api<GroupOption[]>('/groups').then(setAllGroups).catch(() => undefined);
    api<RolesMatrix>('/roles').then(setMatrix).catch(() => undefined);
  }, [canManage, canGroups, load]);

  /** Runs one change, shows the server's result and reloads. */
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      toast.success(done);
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
    try {
      for (const g of added) await api(`/groups/${g}/members`, { method: 'POST', body: { userIds: [id] } });
      for (const g of removed) await api(`/groups/${g}/members/${id}`, { method: 'DELETE' });
      toast.success('Groups saved.');
      await load();
    } catch (e) {
      setError(errorMessage(e));
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  /** Extras as last saved on the server. Defaults to none if the response omits the field. */
  const savedExtras = person?.extraPermissions ?? [];

  const saveExtras = () => {
    run(() => api(`/users/${id}/permissions`, { method: 'PATCH', body: { permissions: extras } }), 'Additional access saved. It applies from their next request.');
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
        <UserManagementTabs />
        <p className="muted">Only Admins can manage users.</p>
      </>
    );
  }

  return (
    <>
      <UserManagementTabs />
      <p style={{ marginTop: 0 }}><Link href="/users">← All people</Link></p>
      {error && <div className="error" role="alert">{error}</div>}
      {!person && !error && <Loading />}

      {person && (
        <div className="person-cards">
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

          <section className="card" aria-label="Additional access">
            <h3 style={{ marginTop: 0 }}>Additional access</h3>
            {person.orgRole === 'ADMIN' ? (
              <p className="muted" style={{ margin: 0 }}>Admins already hold every permission, so there is nothing to add.</p>
            ) : !matrix ? (
              <p className="muted" style={{ margin: 0 }}>Loading permissions…</p>
            ) : (
              <AdditionalAccess
                roleName={roleLabel(person.orgRole)}
                rolePermissions={matrix.roles.find((r) => r.role === person.orgRole)?.permissions ?? []}
                configurable={matrix.configurable}
                extras={extras}
                onToggle={(key) => {
                  if (!extras.includes(key)) {
                    toast.info(`${permissionLabel(key)} is outside the ${roleLabel(person.orgRole)} role. It is granted to ${person.name} only.`);
                  }
                  setExtras((x) => (x.includes(key) ? x.filter((v) => v !== key) : [...x, key]));
                }}
                dirty={extras.length !== savedExtras.length || extras.some((p) => !savedExtras.includes(p))}
                busy={busy}
                onSave={saveExtras}
              />
            )}
            <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
              These are added on top of the role and apply without signing the person out. Changing the role does not remove them.
              Role defaults are on the <Link href="/roles">Roles / Permissions</Link> tab.
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

/**
 * Toggles for the permissions an Admin may grant one person. Permissions the role already holds are shown on and locked,
 * so a toggle here only ever adds access. The server refuses Admin-only keys and says so if one is sent.
 */
function AdditionalAccess({
  roleName,
  rolePermissions,
  configurable,
  extras,
  onToggle,
  dirty,
  busy,
  onSave,
}: {
  roleName: string;
  rolePermissions: string[];
  configurable: string[];
  extras: string[];
  onToggle: (key: string) => void;
  dirty: boolean;
  busy: boolean;
  onSave: () => void;
}) {
  const [open, setOpen] = useState(false);
  const fromRole = new Set(rolePermissions);
  const byArea = new Map<string, string[]>();
  for (const key of [...configurable].sort()) {
    const area = key.split('.')[0];
    byArea.set(area, [...(byArea.get(area) ?? []), key]);
  }

  if (!open) {
    return (
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <span className="muted" style={{ fontSize: 13 }}>
          {extras.length === 0 ? 'No extra permissions for this person.' : `${extras.length} extra ${extras.length === 1 ? 'permission' : 'permissions'} granted to this person.`}
        </span>
        <button className="btn btn-sm" type="button" onClick={() => setOpen(true)} aria-expanded={false}>
          <i className="fa-solid fa-user-shield" aria-hidden /> Show additional access
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: 8 }}>
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          Extra permissions for this person on top of their {roleName} role. For example, a Pre Approver can be given edit rights.
        </p>
        <button className="btn btn-sm" type="button" onClick={() => setOpen(false)} aria-expanded>
          Hide additional access
        </button>
      </div>
      <div className="rl-areas">
        {[...byArea.entries()].map(([area, keys]) => {
          const on = keys.filter((k) => fromRole.has(k) || extras.includes(k)).length;
          return (
            <fieldset key={area} className="rl-area">
              <legend className="rl-area-head">
                <span className="rl-area-name">{areaName(area)}</span>
                <span className="muted rl-area-count">{on}/{keys.length}</span>
              </legend>
              <ul className="rl-perms">
                {keys.map((k) => {
                  const included = fromRole.has(k);
                  const checked = included || extras.includes(k);
                  const added = !included && extras.includes(k);
                  return (
                    <li key={k}>
                      <label className={`rl-perm${added ? ' is-changed' : ''}`}>
                        <span>
                          {actionLabel(k)}
                          {included && <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>from {roleName}</span>}
                        </span>
                        <input
                          type="checkbox"
                          role="switch"
                          className="rl-switch"
                          aria-label={`${areaName(area)} · ${actionLabel(k)}`}
                          checked={checked}
                          disabled={busy || included}
                          onChange={() => onToggle(k)}
                        />
                      </label>
                    </li>
                  );
                })}
              </ul>
            </fieldset>
          );
        })}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button className="btn btn-sm btn-primary" type="button" disabled={busy || !dirty} onClick={onSave}>Save access</button>
      </div>
    </>
  );
}
