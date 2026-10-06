'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { adoptSession, api, refreshSession, type SessionResponse } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/format';
import { roleLabel } from '@/lib/permissions';

export default function ProfilePage() {
  const { user } = useAuth();
  const [name, setName] = useState(user?.name ?? '');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
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
      setMsg({ ok: true, text: ok });
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
    }
  }

  async function saveName(e: FormEvent) {
    e.preventDefault();
    try {
      await api('/profile', { method: 'PATCH', body: { name } });
      await refreshSession();
      setMsg({ ok: true, text: 'Profile updated.' });
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
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
      setMsg({ ok: true, text: 'Password changed. All other sessions were signed out.' });
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
    }
  }

  return (
    <>
      <h1>My profile</h1>
      <p className="muted">
        {user?.email} · {user && roleLabel(user.role)}
      </p>
      {msg && <div className={msg.ok ? 'success' : 'error'}>{msg.text}</div>}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
        <form className="card" onSubmit={saveName}>
          <h3 style={{ marginTop: 0 }}>Details</h3>
          <div className="field">
            <label htmlFor="name">Name</label>
            <input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <button className="btn btn-primary" type="submit">
            Save
          </button>
        </form>
        <form className="card" onSubmit={changePassword}>
          <h3 style={{ marginTop: 0 }}>Change password</h3>
          <div className="field">
            <label htmlFor="cur">Current password</label>
            <input id="cur" type="password" required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="new">New password (min. 10 characters)</label>
            <input id="new" type="password" required minLength={10} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </div>
          <button className="btn btn-primary" type="submit">
            Change password
          </button>
        </form>
      </div>

      <div className="card" style={{ marginTop: 16, maxWidth: 520 }}>
        <h3 style={{ marginTop: 0 }}>Two-factor authentication</h3>
        {mfaEnabled === null ? (
          <p className="muted">Loading…</p>
        ) : mfaEnabled ? (
          <>
            <p>
              <span className="badge badge-green">Enabled</span> Sign-in requires a code from your authenticator app.
            </p>
            <div className="row">
              <input type="password" placeholder="Password" value={mfaPassword} onChange={(e) => setMfaPassword(e.target.value)} style={{ width: 180 }} />
              <input inputMode="numeric" placeholder="6-digit code" maxLength={6} value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} style={{ width: 130 }} />
              <button
                className="btn btn-danger"
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
            <p>Scan this QR code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…), then enter the code it shows.</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={mfaSetup.qrDataUrl} alt="MFA QR code" width={180} height={180} />
            <p className="muted" style={{ fontSize: 12, wordBreak: 'break-all' }}>
              Or enter this key manually: <code>{mfaSetup.secret}</code>
            </p>
            <div className="row">
              <input inputMode="numeric" placeholder="6-digit code" maxLength={6} value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} style={{ width: 140 }} />
              <button
                className="btn btn-primary"
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
            <p className="muted">Protect your account with a one-time code from an authenticator app.</p>
            <button className="btn btn-primary" onClick={() => mfaAction(async () => setMfaSetup(await api('/profile/mfa/setup', { method: 'POST' })), 'Scan the QR code to continue.')}>
              Set up two-factor authentication
            </button>
          </>
        )}
      </div>
    </>
  );
}
