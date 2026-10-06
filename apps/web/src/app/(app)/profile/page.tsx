'use client';

import { useToast } from '@/components/feedback/Toast';
import { Loading } from '@/components/feedback/Loading';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { adoptSession, api, refreshSession, type SessionResponse } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/format';
import { hasPermission, roleLabel } from '@/lib/permissions';
import { PREVIEWABLE_ROLES, setPreviewRole } from '@/lib/preview-role';
import type { Role } from '@/lib/api';
import { Avatar, ROLE_ICON } from '@/components/users/Avatar';

export default function ProfilePage() {
  const { user, realUser, previewRole } = useAuth();
  const router = useRouter();
  const [name, setName] = useState(user?.name ?? '');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const toast = useToast();
  const [mfaEnabled, setMfaEnabled] = useState<boolean | null>(null);
  const [mfaSetup, setMfaSetup] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaPassword, setMfaPassword] = useState('');

  useEffect(() => {
    api<{ mfaEnabled: boolean }>('/profile').then((p) => setMfaEnabled(p.mfaEnabled)).catch(() => undefined);
  }, []);

  async function mfaAction(fn: () => Promise<void>, ok: string) {
    try {
      await fn();
      setMfaCode('');
      setMfaPassword('');
      toast.success(ok);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function saveName(e: FormEvent) {
    e.preventDefault();
    try {
      await api('/profile', { method: 'PATCH', body: { name } });
      await refreshSession();
      toast.success('Profile updated.');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    try {
      await api('/profile/password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
      // The response set a fresh refresh cookie; pick up the new access token.
      await refreshSession();
      setCurrent('');
      setNext('');
      toast.success('Password changed. All other sessions were signed out.');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const me = realUser ?? user;

  return (
    <>
      {me && (
        <section className="pf-hero">
          <Avatar name={me.name} size={64} />
          <div className="pf-hero-text">
            <h2>{me.name}</h2>
            <span className="pf-hero-meta">
              <i className="fa-solid fa-envelope" aria-hidden /> {me.email}
            </span>
          </div>
          <div className="pf-hero-badges">
            <span className="pf-role">
              <i className={`fa-solid ${ROLE_ICON[me.role] ?? 'fa-user-tag'}`} aria-hidden /> {roleLabel(me.role)}
            </span>
            {mfaEnabled !== null && (
              <span className={`pf-role ${mfaEnabled ? 'is-on' : 'is-off'}`}>
                <i className={`fa-solid ${mfaEnabled ? 'fa-shield-halved' : 'fa-shield'}`} aria-hidden /> Two-factor {mfaEnabled ? 'on' : 'off'}
              </span>
            )}
          </div>
        </section>
      )}


      <div className="pf-grid">
        <form className="card pf-card" onSubmit={saveName}>
          <div className="pf-card-head">
            <span className="kpi-icon"><i className="fa-solid fa-id-card" aria-hidden /></span>
            <div>
              <h3>Details</h3>
              <p className="muted">The name other people see on SOPs, approvals and checklists.</p>
            </div>
          </div>
          <div className="field">
            <label htmlFor="name">Name</label>
            <input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" value={me?.email ?? ''} disabled />
          </div>
          <div className="pf-actions">
            <button className="btn btn-primary" type="submit">
              Save details
            </button>
          </div>
        </form>

        <form className="card pf-card" onSubmit={changePassword}>
          <div className="pf-card-head">
            <span className="kpi-icon"><i className="fa-solid fa-key" aria-hidden /></span>
            <div>
              <h3>Change password</h3>
              <p className="muted">Changing it signs you out on every other device.</p>
            </div>
          </div>
          <div className="field">
            <label htmlFor="cur">Current password</label>
            <input id="cur" type="password" required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="new">New password (min. 10 characters)</label>
            <input id="new" type="password" required minLength={10} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </div>
          <div className="pf-actions">
            <button className="btn btn-primary" type="submit">
              Change password
            </button>
          </div>
        </form>

        <section className="card pf-card">
          <div className="pf-card-head">
            <span className="kpi-icon"><i className="fa-solid fa-shield-halved" aria-hidden /></span>
            <div>
              <h3>Two-factor authentication</h3>
              <p className="muted">A one-time code from an authenticator app, asked for at every sign-in.</p>
            </div>
          </div>
          {mfaEnabled === null ? (
            <Loading />
          ) : mfaEnabled ? (
            <>
              <p className="pf-status">
                <span className="badge badge-green">Enabled</span> Sign-in requires a code from your authenticator app.
              </p>
              <p className="muted pf-small">To turn it off, confirm with your password and a current code.</p>
              <div className="pf-inline">
                <input type="password" placeholder="Password" aria-label="Password" value={mfaPassword} onChange={(e) => setMfaPassword(e.target.value)} />
                <input inputMode="numeric" placeholder="6-digit code" aria-label="6-digit code" maxLength={6} value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} />
                <button
                  className="btn btn-danger"
                  type="button"
                  onClick={() =>
                    mfaAction(async () => {
                      await api('/profile/mfa/disable', { method: 'POST', body: { password: mfaPassword, code: mfaCode } });
                      setMfaEnabled(false);
                    }, 'Two-factor authentication disabled.')
                  }
                >
                  Disable
                </button>
              </div>
            </>
          ) : mfaSetup ? (
            <>
              <p className="pf-small">Scan this QR code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…), then enter the code it shows.</p>
              <div className="pf-qr">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={mfaSetup.qrDataUrl} alt="MFA QR code" width={160} height={160} />
                <p className="muted pf-small">
                  Or enter this key manually:
                  <br />
                  <span className="ui-code pf-secret">{mfaSetup.secret}</span>
                </p>
              </div>
              <div className="pf-inline">
                <input inputMode="numeric" placeholder="6-digit code" aria-label="6-digit code" maxLength={6} value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} />
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={() =>
                    mfaAction(async () => {
                      const s = await api<SessionResponse>('/profile/mfa/enable', { method: 'POST', body: { code: mfaCode } });
                      adoptSession(s);
                      setMfaSetup(null);
                      setMfaEnabled(true);
                    }, 'Two-factor authentication enabled. Other sessions were signed out.')
                  }
                >
                  Verify & enable
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="pf-status">
                <span className="badge">Off</span> Your account is protected by your password only.
              </p>
              <div className="pf-actions">
                <button className="btn btn-primary" type="button" onClick={() => mfaAction(async () => setMfaSetup(await api('/profile/mfa/setup', { method: 'POST' })), 'Scan the QR code to continue.')}>
                  <i className="fa-solid fa-qrcode" aria-hidden /> Set up two-factor
                </button>
              </div>
            </>
          )}
        </section>

        {realUser && hasPermission(realUser, 'roles.manage') && (
          <section className="card pf-card">
            <div className="pf-card-head">
              <span className="kpi-icon"><i className="fa-solid fa-eye" aria-hidden /></span>
              <div>
                <h3>Preview as role</h3>
                <p className="muted">
                  See the app the way another role would, without a second account. This only changes what is shown. Your real {roleLabel(realUser.role)} access is unchanged underneath.
                </p>
              </div>
            </div>
            <div className="pf-roles" role="radiogroup" aria-label="Preview as role">
              {[null, ...PREVIEWABLE_ROLES].map((r) => {
                const on = (previewRole ?? null) === r;
                const role = r ?? realUser.role;
                return (
                  <button
                    key={r ?? 'self'}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    className={`pf-role-opt${on ? ' is-on' : ''}`}
                    onClick={() => {
                      setPreviewRole(r as Role | null);
                      router.push('/sops');
                    }}
                  >
                    <i className={`fa-solid ${ROLE_ICON[role] ?? 'fa-user-tag'}`} aria-hidden />
                    <span>{roleLabel(role)}</span>
                    {r === null && <span className="pf-you">You</span>}
                  </button>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </>
  );
}
