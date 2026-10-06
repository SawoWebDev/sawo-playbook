'use client';

import { useToast } from '@/components/feedback/Toast';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Role } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage, plural } from '@/lib/format';
import { hasPermission, roleLabel } from '@/lib/permissions';
import { UserManagementTabs } from '@/components/UserManagementTabs';
import { ROLE_ICON } from '@/components/users/Avatar';

interface RoleRow {
  role: Role;
  label: string;
  locked: boolean;
  customised: boolean;
  permissions: string[];
}

interface RolesResponse {
  roles: RoleRow[];
  configurable: string[];
  adminOnly: string[];
  defaults: Partial<Record<Role, string[]>>;
}

const AREA_NAME: Record<string, string> = { kanban: 'Kanbans', sop: 'STD OPS', org: 'Organisation', skills: 'Skills', analytics: 'Analytics', audit: 'Audit' };
const AREA_ICON: Record<string, string> = { kanban: 'fa-table-columns', sop: 'fa-file-lines', skills: 'fa-certificate', analytics: 'fa-chart-line', audit: 'fa-clipboard-list', org: 'fa-building', users: 'fa-users', groups: 'fa-user-group', roles: 'fa-shield-halved' };

const areaName = (area: string) => AREA_NAME[area] ?? area.charAt(0).toUpperCase() + area.slice(1);

/** The action part of a permission key, as words. Wording only; the set of permissions comes from the API. */
function actionLabel(key: string): string {
  const action = key.split('.').slice(1).join(' ').replace(/_/g, ' ');
  return action.charAt(0).toUpperCase() + action.slice(1);
}

/** Display text for a permission key, with its area. */
function permissionLabel(key: string): string {
  return `${areaName(key.split('.')[0])} · ${actionLabel(key)}`;
}

function sameSet(a: string[], b: string[]): boolean {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * Role & permission matrix. The matrix, the defaults and the Admin-only list all come from GET /roles. The server
 * refuses Admin edits and any Admin-only permission for another role; this screen reflects those results.
 */
export default function RolesPage() {
  const { user } = useAuth();
  const allowed = hasPermission(user, 'roles.manage');
  const [data, setData] = useState<RolesResponse | null>(null);
  const [memberCounts, setMemberCounts] = useState<Record<string, number> | null>(null);
  const [selected, setSelected] = useState<Role>('EDITOR');
  const [draft, setDraft] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const load = useCallback(async () => {
    setData(await api<RolesResponse>('/roles'));
  }, []);

  useEffect(() => {
    if (!allowed) return;
    load().catch((e) => setError(errorMessage(e)));
    // People per role, for the role cards. Optional: the cards simply omit the count if the list is not available.
    api<{ orgRole: string; status: string }[]>('/users')
      .then((list) => {
        const counts: Record<string, number> = {};
        for (const u of list) if (u.status !== 'removed') counts[u.orgRole] = (counts[u.orgRole] ?? 0) + 1;
        setMemberCounts(counts);
      })
      .catch(() => setMemberCounts(null));
  }, [allowed, load]);

  const current = useMemo(() => data?.roles.find((r) => r.role === selected) ?? null, [data, selected]);
  const configurable = useMemo(() => data?.configurable ?? [], [data]);
  const saved = useMemo(() => current?.permissions.filter((p) => configurable.includes(p)) ?? [], [current, configurable]);

  useEffect(() => {
    setDraft(saved);
  }, [saved]);

  if (!allowed) {
    return (
      <>
        <UserManagementTabs />
        <p className="muted">Only Admins can view or change role permissions.</p>
      </>
    );
  }

  const dirty = !!current && !current.locked && !sameSet(draft, saved);
  const atDefaults = !!current && sameSet(current.permissions, data?.defaults[current.role] ?? []);

  const toggle = (permission: string) => setDraft((d) => (d.includes(permission) ? d.filter((p) => p !== permission) : [...d, permission]));
  const setArea = (keys: string[], on: boolean) => setDraft((d) => (on ? [...new Set([...d, ...keys])] : d.filter((p) => !keys.includes(p))));

  const selectRole = (role: Role) => {
    if (role === selected) return;
    if (dirty && !confirm('Discard your unsaved changes to this role?')) return;
    setSelected(role);
  };

  const save = async () => {
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      setData(await api<RolesResponse>(`/roles/${current.role}`, { method: 'PUT', body: { permissions: draft } }));
      toast.success(`${roleLabel(current.role)} permissions saved. The change applies to each person's next request.`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!current) return;
    setConfirmReset(false);
    setBusy(true);
    setError(null);
    try {
      setData(await api<RolesResponse>(`/roles/${current.role}`, { method: 'DELETE' }));
      toast.success(`${roleLabel(current.role)} reset to the default permissions.`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const byArea = configurable.reduce<Record<string, string[]>>((acc, p) => {
    (acc[p.split('.')[0]] ??= []).push(p);
    return acc;
  }, {});

  return (
    <>
      <UserManagementTabs />

      <div className="grp-head">
        <div>
          <h2 style={{ margin: 0 }}>Roles / Permissions</h2>
          <p className="muted grp-lead">
            Each role has a set of permissions. Admin always holds all of them. Admin-only permissions cannot be given to other roles.
          </p>
        </div>
      </div>

      {error && <div className="error" role="alert">{error}</div>}

      {!data ? (
        <p className="muted" role="status">Loading permissions…</p>
      ) : (
        <>
          <div className="rl-roles" role="tablist" aria-label="Roles">
            {data.roles.map((r) => {
              const count = r.locked ? configurable.length + data.adminOnly.length : r.permissions.filter((p) => configurable.includes(p)).length;
              const total = r.locked ? count : configurable.length;
              return (
                <button
                  key={r.role}
                  type="button"
                  role="tab"
                  aria-selected={selected === r.role}
                  className={`rl-role${selected === r.role ? ' is-selected' : ''}`}
                  onClick={() => selectRole(r.role)}
                >
                  <span className="grp-icon"><i className={`fa-solid ${ROLE_ICON[r.role] ?? 'fa-user-tag'}`} aria-hidden /></span>
                  <span className="rl-role-text">
                    <span className="rl-role-name">{roleLabel(r.role)}</span>
                    <span className="muted rl-role-meta">
                      {r.locked ? 'All permissions' : `${count} of ${total} permissions`}
                      {memberCounts && ` · ${plural(memberCounts[r.role] ?? 0, 'person', 'people')}`}
                    </span>
                  </span>
                  {r.locked ? (
                    <i className="fa-solid fa-lock rl-role-tag" title="Fixed" aria-label="Fixed" />
                  ) : (
                    r.customised && <span className="grp-chip rl-custom">Customised</span>
                  )}
                </button>
              );
            })}
          </div>

          {current && (
            <section className="um-card rl-panel" aria-label={`${roleLabel(current.role)} permissions`}>
              <header className="rl-panel-head">
                <div className="grp-title">
                  <h3>{roleLabel(current.role)}</h3>
                  <span className="muted">
                    {current.locked ? 'Fixed — Admin holds every permission and cannot be changed.' : `${draft.length} of ${configurable.length} permissions enabled`}
                  </span>
                </div>
                {!current.locked && (
                  <button className="btn btn-sm" type="button" disabled={busy || atDefaults || !data.defaults[current.role]} onClick={() => setConfirmReset(true)}>
                    <i className="fa-solid fa-rotate-left" aria-hidden /> Reset to defaults
                  </button>
                )}
              </header>

              <div className="rl-areas">
                {Object.entries(byArea).map(([area, keys]) => {
                  const on = current.locked ? keys.length : keys.filter((k) => draft.includes(k)).length;
                  const all = on === keys.length;
                  return (
                    <fieldset key={area} className="rl-area">
                      <legend className="rl-area-head">
                        <span className="rl-area-icon"><i className={`fa-solid ${AREA_ICON[area] ?? 'fa-key'}`} aria-hidden /></span>
                        <span className="rl-area-name">{areaName(area)}</span>
                        <span className="muted rl-area-count">{on}/{keys.length}</span>
                      </legend>
                      {!current.locked && (
                        <button type="button" className="rl-area-all" disabled={busy} onClick={() => setArea(keys, !all)}>
                          {all ? 'Clear all' : 'Select all'}
                        </button>
                      )}
                      <ul className="rl-perms">
                        {keys.map((p) => {
                          const checked = current.locked || draft.includes(p);
                          const changed = !current.locked && checked !== saved.includes(p);
                          return (
                            <li key={p}>
                              <label className={`rl-perm${changed ? ' is-changed' : ''}`}>
                                <span>{actionLabel(p)}</span>
                                <input
                                  type="checkbox"
                                  role="switch"
                                  className="rl-switch"
                                  aria-label={permissionLabel(p)}
                                  checked={checked}
                                  disabled={busy || current.locked}
                                  onChange={() => toggle(p)}
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

              {!current.locked && data.adminOnly.length > 0 && (
                <div className="rl-admin-only">
                  <div className="rl-admin-only-head">
                    <i className="fa-solid fa-lock" aria-hidden /> Admin only — cannot be given to this role
                  </div>
                  <div className="rl-admin-only-list">
                    {data.adminOnly.map((p) => (
                      <span key={p} className="rl-locked-chip">{permissionLabel(p)}</span>
                    ))}
                  </div>
                </div>
              )}

              {dirty && (
                <div className="rl-savebar" role="status">
                  <span>
                    <i className="fa-solid fa-circle-exclamation" aria-hidden /> Unsaved changes to {roleLabel(current.role)}
                  </span>
                  <div className="row">
                    <button className="btn btn-sm" type="button" disabled={busy} onClick={() => setDraft(saved)}>Discard</button>
                    <button className="btn btn-sm btn-primary" type="button" disabled={busy} onClick={save}>
                      {busy ? 'Saving…' : 'Save permissions'}
                    </button>
                  </div>
                </div>
              )}
            </section>
          )}
        </>
      )}

      {confirmReset && current && (
        <div className="dialog-backdrop" role="presentation" onClick={() => setConfirmReset(false)}>
          <div className="card dialog" role="dialog" aria-modal="true" aria-label="Confirm reset" onClick={(e) => e.stopPropagation()}>
            <h3>Reset {roleLabel(current.role)} to defaults?</h3>
            <p className="muted">Your changes to this role are removed. Everyone with this role gets the default permissions on their next request.</p>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" type="button" onClick={() => setConfirmReset(false)}>Cancel</button>
              <button className="btn btn-danger" type="button" onClick={reset}>Reset</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
