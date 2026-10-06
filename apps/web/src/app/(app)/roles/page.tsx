'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Role } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/format';
import { hasPermission, roleLabel } from '@/lib/permissions';
import { UserManagementTabs } from '@/components/UserManagementTabs';

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

/** Display text for a permission key. Grouping and wording only; the set of permissions comes from the API. */
function permissionLabel(key: string): string {
  const [area, ...rest] = key.split('.');
  const action = rest.join(' ').replace(/_/g, ' ');
  const areaName: Record<string, string> = { kanban: 'Kanban', sop: 'STD OPS', org: 'Organisation' };
  return `${areaName[area] ?? area.charAt(0).toUpperCase() + area.slice(1)} · ${action.charAt(0).toUpperCase() + action.slice(1)}`;
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
  const [selected, setSelected] = useState<Role>('EDITOR');
  const [draft, setDraft] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const load = useCallback(async () => {
    const r = await api<RolesResponse>('/roles');
    setData(r);
  }, []);

  useEffect(() => {
    if (allowed) load().catch((e) => setError(errorMessage(e)));
  }, [allowed, load]);

  const current = useMemo(() => data?.roles.find((r) => r.role === selected) ?? null, [data, selected]);

  useEffect(() => {
    if (current) setDraft(current.permissions.filter((p) => data?.configurable.includes(p)));
  }, [current, data]);

  if (!allowed) {
    return (
      <>
        <h1>Roles &amp; Permissions</h1>
        <p className="muted">Only Admins can view or change role permissions.</p>
      </>
    );
  }

  const dirty = !!current && !current.locked && !sameSet(draft, current.permissions.filter((p) => data?.configurable.includes(p)));

  const toggle = (permission: string) => setDraft((d) => (d.includes(permission) ? d.filter((p) => p !== permission) : [...d, permission]));

  const save = async () => {
    if (!current) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await api<RolesResponse>(`/roles/${current.role}`, { method: 'PUT', body: { permissions: draft } });
      setData(next);
      setNotice(`${roleLabel(current.role)} permissions saved. The change applies to each person's next request.`);
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
    setNotice(null);
    try {
      const next = await api<RolesResponse>(`/roles/${current.role}`, { method: 'DELETE' });
      setData(next);
      setNotice(`${roleLabel(current.role)} reset to the default permissions.`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const configurable = data?.configurable ?? [];
  const byArea = configurable.reduce<Record<string, string[]>>((acc, p) => {
    const area = p.split('.')[0];
    (acc[area] ??= []).push(p);
    return acc;
  }, {});

  return (
    <>
      <h1>User Management</h1>
      <UserManagementTabs />
      <h2>Roles &amp; Permissions</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Each role has a set of permissions. Admin always holds all of them and cannot be changed. Admin-only permissions are protected and cannot be given to other roles.
      </p>
      {error && <div className="error" role="alert">{error}</div>}
      {notice && <div className="success">{notice}</div>}

      {!data ? (
        <p className="muted">Loading permissions…</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 220px) 1fr', gap: 16, alignItems: 'start' }}>
          <nav className="card" aria-label="Roles">
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {data.roles.map((r) => (
                <li key={r.role} style={{ marginBottom: 4 }}>
                  <button type="button" className={`btn btn-sm ${selected === r.role ? 'btn-primary' : ''}`} style={{ width: '100%', textAlign: 'left' }} aria-pressed={selected === r.role} onClick={() => setSelected(r.role)}>
                    {roleLabel(r.role)}
                    {r.locked && <span className="muted"> · fixed</span>}
                    {r.customised && <span className="badge badge-blue" style={{ marginLeft: 6 }}>Customised</span>}
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          <section className="card" aria-label="Permission matrix">
            {current && (
              <>
                <div className="row" style={{ marginBottom: 12 }}>
                  <h3 style={{ margin: 0 }}>{roleLabel(current.role)}</h3>
                  {current.locked && <span className="badge badge-amber">Fixed — Admin holds every permission</span>}
                  <div className="spacer" />
                  {!current.locked && (
                    <>
                      <button className="btn btn-sm" type="button" disabled={busy || !dirty} onClick={() => setDraft(current.permissions.filter((p) => configurable.includes(p)))}>
                        Discard changes
                      </button>
                      <button className="btn btn-sm btn-primary" type="button" disabled={busy || !dirty} onClick={save}>
                        Save permissions
                      </button>
                      <button className="btn btn-sm" type="button" disabled={busy || !data.defaults[current.role] || sameSet(current.permissions, data.defaults[current.role] ?? [])} onClick={() => setConfirmReset(true)}>
                        Reset to defaults
                      </button>
                    </>
                  )}
                </div>

                {current.locked ? (
                  <p className="muted">Admin permissions are fixed. The current set, shown for reference: {current.permissions.length} permissions.</p>
                ) : (
                  Object.entries(byArea).map(([area, keys]) => (
                    <fieldset key={area} style={{ border: 0, padding: 0, marginBottom: 14 }}>
                      <legend style={{ fontWeight: 600, marginBottom: 6 }}>{area === 'kanban' ? 'Kanbans' : area === 'sop' ? 'STD OPS' : area.charAt(0).toUpperCase() + area.slice(1)}</legend>
                      <div className="toggle-row">
                        {keys.map((p) => (
                          <label key={p} className="row" style={{ fontWeight: 400, margin: 0 }}>
                            <input type="checkbox" style={{ width: 'auto' }} checked={draft.includes(p)} disabled={busy} onChange={() => toggle(p)} />
                            {permissionLabel(p)}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  ))
                )}

                {!current.locked && (
                  <fieldset style={{ border: 0, padding: 0, marginTop: 18 }}>
                    <legend style={{ fontWeight: 600, marginBottom: 6 }}>Admin only — cannot be given to this role</legend>
                    <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
                      {data.adminOnly.map((p) => (
                        <li key={p}>{permissionLabel(p)}</li>
                      ))}
                    </ul>
                  </fieldset>
                )}
              </>
            )}
          </section>
        </div>
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
