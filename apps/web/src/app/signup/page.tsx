'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useAuth } from '@/lib/auth';

export default function SignupPage() {
  const { signup } = useAuth();
  const router = useRouter();
  const [form, setForm] = useState({ organizationName: '', name: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signup(form);
      router.replace('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Signup failed');
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
        <h1>Create your organization</h1>
        <div className="field">
          <label htmlFor="org">Organization name</label>
          <input id="org" required value={form.organizationName} onChange={set('organizationName')} />
        </div>
        <div className="field">
          <label htmlFor="name">Your name</label>
          <input id="name" required value={form.name} onChange={set('name')} />
        </div>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="email" required value={form.email} onChange={set('email')} />
        </div>
        <div className="field">
          <label htmlFor="password">Password (min. 10 characters)</label>
          <input id="password" type="password" autoComplete="new-password" minLength={10} required value={form.password} onChange={set('password')} />
        </div>
        {error && <div className="error">{error}</div>}
        <button className="btn btn-primary" disabled={busy} type="submit" style={{ width: '100%', justifyContent: 'center' }}>
          {busy ? 'Creating…' : 'Create organization'}
        </button>
        <p className="muted">
          Already have an account? <Link href="/login">Sign in</Link>
        </p>
      </form>
    </div>
  );
}
