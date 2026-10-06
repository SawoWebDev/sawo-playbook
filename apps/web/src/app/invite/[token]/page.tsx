'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { acceptInvite, api, type Role } from '@/lib/api';
import { errorMessage } from '@/lib/format';
import { roleLabel } from '@/lib/permissions';

interface InviteInfo {
  email: string;
  role: Role;
  organizationName: string;
}

export default function AcceptInvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<InviteInfo>(`/auth/invitations/${encodeURIComponent(token)}`)
      .then(setInfo)
      .catch((e) => setError(errorMessage(e)));
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await acceptInvite({ token, name, password });
      router.replace('/');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <form className="card auth-card" onSubmit={submit}>
        <div className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/images/sawo-logo.webp" alt="SAWO" width={400} height={255} />
        </div>
        {!info && !error && <p className="muted">Checking invitation…</p>}
        {info && (
          <>
            <h1>Join {info.organizationName}</h1>
            <p className="muted">
              You were invited as <strong>{roleLabel(info.role)}</strong> ({info.email}).
            </p>
            <div className="field">
              <label htmlFor="name">Your name</label>
              <input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="password">Choose a password (min. 10 characters)</label>
              <input id="password" type="password" minLength={10} autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <button className="btn btn-primary" disabled={busy} type="submit" style={{ width: '100%', justifyContent: 'center' }}>
              {busy ? 'Joining…' : 'Accept invitation'}
            </button>
          </>
        )}
        {error && <div className="error">{error}</div>}
      </form>
    </div>
  );
}
