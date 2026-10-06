'use client';

import { useState, type FormEvent } from 'react';
import { api, type Role } from '@/lib/api';
import { errorMessage } from '@/lib/format';
import { ASSIGNABLE_ROLES, roleLabel } from '@/lib/permissions';
import type { GroupOption } from './InviteDialog';

interface Created {
  name: string;
  email: string;
  password: string;
}

const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A random temporary password. The Admin can still type their own. */
function generatePassword(length = 14): string {
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

/**
 * Create an account now with a temporary password. The server enforces the role and group rules and hashes the
 * password; the user must replace it at first sign-in. The password is shown once, here, so the Admin can pass it on.
 */
export function CreateUserDialog({ groups, onClose, onDone }: { groups: GroupOption[]; onClose: () => void; onDone: (message: string) => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('OPERATOR');
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [password, setPassword] = useState(() => generatePassword());
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

  const toggleGroup = (id: string) => setGroupIds((g) => (g.includes(id) ? g.filter((x) => x !== id) : [...g, id]));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ email: string; name: string }>('/users', {
        method: 'POST',
        body: { name: name.trim(), email: email.trim(), role, groupIds, temporaryPassword: password },
      });
      setCreated({ name: r.name, email: r.email, password });
      onDone(`Account created for ${r.email}.`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <div className="dialog-backdrop" role="presentation" onClick={onClose}>
        <div className="card dialog" role="dialog" aria-modal="true" aria-label="Account created" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
          <h3 style={{ marginTop: 0 }}>Account created</h3>
          <p>
            Send these details to {created.name} yourself. They will be asked to set their own password when they first sign in.
            This password is shown only now.
          </p>
          <div className="field">
            <label htmlFor="cu-username">Username (email)</label>
            <div className="row">
              <input id="cu-username" readOnly value={created.email} style={{ flex: 1 }} onFocus={(e) => e.currentTarget.select()} />
              <button className="btn btn-sm" type="button" onClick={() => navigator.clipboard?.writeText(created.email)}>Copy</button>
            </div>
          </div>
          <div className="field">
            <label htmlFor="cu-password">Temporary password</label>
            <div className="row">
              <input id="cu-password" readOnly value={created.password} style={{ flex: 1, fontFamily: 'monospace' }} onFocus={(e) => e.currentTarget.select()} />
              <button className="btn btn-sm" type="button" onClick={() => navigator.clipboard?.writeText(created.password)}>Copy</button>
            </div>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button className="btn btn-primary" type="button" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div className="card dialog" role="dialog" aria-modal="true" aria-label="Create user" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>Create user</h3>
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="cu-name">Name</label>
            <input id="cu-name" required value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="cu-email">Email (their username)</label>
            <input id="cu-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="cu-role">Role</label>
            <select id="cu-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
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
          <div className="field">
            <label htmlFor="cu-temp">Temporary password</label>
            <div className="row">
              <input id="cu-temp" type={showPassword ? 'text' : 'password'} required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} style={{ flex: 1 }} />
              <button className="btn btn-sm" type="button" onClick={() => setShowPassword((s) => !s)}>{showPassword ? 'Hide' : 'Show'}</button>
              <button className="btn btn-sm" type="button" onClick={() => setPassword(generatePassword())}>Generate</button>
            </div>
            <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>At least 10 characters. The user replaces it at first sign-in.</p>
          </div>
          {error && <div className="error" role="alert">{error}</div>}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" type="button" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" type="submit" disabled={busy || !name.trim() || !email.trim() || password.length < 10}>
              Create user
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
