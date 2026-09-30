'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errorMessage, fmtDateTime } from '@/lib/format';

interface AuditItem {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  occurredAt: string;
  actor: { id: string; name: string; email: string } | null;
}

export default function AuditPage() {
  const [items, setItems] = useState<AuditItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (before?: string) => {
      try {
        const q = new URLSearchParams({ limit: '50' });
        if (filter) q.set('action', filter);
        if (before) q.set('before', before);
        const r = await api<{ items: AuditItem[]; nextBefore: string | null }>(`/audit-log?${q}`);
        setItems((prev) => (before ? [...prev, ...r.items] : r.items));
        setNext(r.nextBefore);
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [filter],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <h1>Audit log</h1>
      <div className="row" style={{ marginBottom: 12 }}>
        <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 260 }}>
          <option value="">All events</option>
          <option value="auth.">Authentication</option>
          <option value="user.">Users</option>
          <option value="org.">Organization</option>
          <option value="sop.">SOP approvals</option>
          <option value="kanban.">Kanbans</option>
          <option value="skills.">Skills</option>
        </select>
      </div>
      {error && <div className="error">{error}</div>}
      <table className="table">
        <thead>
          <tr>
            <th>When</th>
            <th>Action</th>
            <th>Actor</th>
            <th>Entity</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id}>
              <td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(i.occurredAt)}</td>
              <td>
                <code>{i.action}</code>
              </td>
              <td>{i.actor?.name ?? '—'}</td>
              <td className="muted">{i.entityType ?? ''}</td>
              <td className="muted" style={{ fontSize: 12, maxWidth: 360, wordBreak: 'break-word' }}>
                {Object.keys(i.metadata ?? {}).length ? JSON.stringify(i.metadata) : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {next && (
        <button className="btn" style={{ marginTop: 12 }} onClick={() => load(next)}>
          Load more
        </button>
      )}
    </>
  );
}
