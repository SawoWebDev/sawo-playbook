'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { loginMfa } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <Login />
    </Suspense>
  );
}

/** Only same-origin relative paths are honoured for ?next= (no open redirects). */
function safeNext(v: string | null): string {
  return v && v.startsWith('/') && !v.startsWith('//') ? v : '/';
}

function Login() {
  const { login } = useAuth();
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mfaToken) {
        await loginMfa(mfaToken, code);
        router.replace(next);
        return;
      }
      const r = await login(email, password);
      if ('mfaRequired' in r) {
        setMfaToken(r.mfaToken);
        return;
      }
      router.replace(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <form className="card auth-card" onSubmit={submit}>
        <div className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/images/sawo-logo.webp" alt="SAWO" width={479} height={300} />
        </div>
        <h1>Sign in</h1>
        {mfaToken ? (
          <div className="field">
            <label htmlFor="code">Authentication code</label>
            <input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              autoFocus
              required
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
            <p className="muted" style={{ fontSize: 12 }}>
              Enter the 6-digit code from your authenticator app.
            </p>
          </div>
        ) : (
          <>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
          </>
        )}
        {error && <div className="error">{error}</div>}
        <button className="btn btn-primary" disabled={busy} type="submit" style={{ width: '100%', justifyContent: 'center' }}>
          {busy ? 'Signing in…' : mfaToken ? 'Verify' : 'Sign in'}
        </button>
        <p className="muted">
          <Link href="/forgot-password">Forgot password?</Link> · New organization? <Link href="/signup">Create an account</Link>
        </p>
      </form>
    </div>
  );
}
