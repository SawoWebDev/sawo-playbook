'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/format';

export default function ResetPasswordPage() {
  const { token } = useParams<{ token: string }>();
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api('/auth/reset-password', { method: 'POST', body: { token, newPassword: password } });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="auth-wrap">
      <form className="card auth-card" onSubmit={submit}>
        <div className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/images/sawo-logo.webp" alt="SAWO" width={479} height={300} />
        </div>
        <h1>Choose a new password</h1>
        {done ? (
          <p className="success">
            Password updated. All other sessions were signed out. <Link href="/login">Sign in</Link>
          </p>
        ) : (
          <>
            <div className="field">
              <label htmlFor="pw">New password (min. 10 characters)</label>
              <input id="pw" type="password" minLength={10} required autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            {error && <div className="error">{error}</div>}
            <button className="btn btn-primary" type="submit" style={{ width: '100%', justifyContent: 'center' }}>
              Update password
            </button>
          </>
        )}
      </form>
    </div>
  );
}
