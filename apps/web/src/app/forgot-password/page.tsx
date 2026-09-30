'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/format';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api('/auth/forgot-password', { method: 'POST', body: { email } });
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="auth-wrap">
      <form className="card auth-card" onSubmit={submit}>
        <div className="brand">GembaDocs</div>
        <h1>Reset password</h1>
        {sent ? (
          <p className="success">If an account exists for that email, a reset link has been sent.</p>
        ) : (
          <>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            {error && <div className="error">{error}</div>}
            <button className="btn btn-primary" type="submit" style={{ width: '100%', justifyContent: 'center' }}>
              Send reset link
            </button>
          </>
        )}
        <p className="muted">
          <Link href="/login">Back to sign in</Link>
        </p>
      </form>
    </div>
  );
}
