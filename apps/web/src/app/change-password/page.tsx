'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { api, refreshSession } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/format';

/**
 * Shown after an Admin created the account with a temporary password. The server refuses every other route until this
 * succeeds, so this page only collects the two passwords and shows the server's answer.
 */
export default function ChangePasswordPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (loading) return;
    if (!user) router.replace('/login');
    else if (!user.passwordMustChange) router.replace('/sops');
  }, [loading, user, router]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (next !== confirm) {
      setError('The two new passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await api('/profile/password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
      // The response set a fresh refresh cookie; pick up the new access token and the cleared requirement.
      await refreshSession();
      router.replace('/sops');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading || !user) return <div className="auth-wrap muted">Loading…</div>;

  return (
    <div className="auth-wrap">
      <form className="card" onSubmit={submit} style={{ maxWidth: 420, width: '100%' }}>
        <h2 style={{ marginTop: 0 }}>Set your password</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          An administrator set a temporary password for your account. Choose your own password to continue.
        </p>
        <div className="field">
          <label htmlFor="cp-current">Temporary password</label>
          <input id="cp-current" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="cp-new">New password</label>
          <input id="cp-new" type="password" autoComplete="new-password" required minLength={10} value={next} onChange={(e) => setNext(e.target.value)} />
          <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>At least 10 characters.</p>
        </div>
        <div className="field">
          <label htmlFor="cp-confirm">Confirm new password</label>
          <input id="cp-confirm" type="password" autoComplete="new-password" required minLength={10} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        {error && <div className="error" role="alert">{error}</div>}
        <button className="btn btn-primary" type="submit" disabled={busy || !current || !next || !confirm}>
          Set password and continue
        </button>
      </form>
    </div>
  );
}
