'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errorMessage, fmtDateTime } from '@/lib/format';

interface ChecklistRow {
  id: string;
  status: 'in_progress' | 'completed' | 'abandoned';
  startedAt: string;
  completedAt: string | null;
  operator: { id: string; name: string } | null;
  sop: { id: string; name: string; referenceNo: string };
  version: { id: string; label: string };
  answered: number;
  totalSteps: number;
  notOk: number;
}

const STATUS_CLS = { in_progress: 'badge-amber', completed: 'badge-green', abandoned: '' } as const;

export default function ChecklistsPage() {
  const [rows, setRows] = useState<ChecklistRow[]>([]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<ChecklistRow[]>(`/checklists${status ? `?status=${status}` : ''}`)
      .then(setRows)
      .catch((e) => setError(errorMessage(e)));
  }, [status]);

  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>Checklists</h1>
        <div className="spacer" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 180 }}>
          <option value="">All</option>
          <option value="in_progress">In progress</option>
          <option value="completed">Completed</option>
          <option value="abandoned">Abandoned</option>
        </select>
      </div>
      {error && <div className="error">{error}</div>}
      <p className="muted">Start a checklist from any SOP that is configured as a Checklist SOP.</p>
      <table className="table">
        <thead>
          <tr>
            <th>SOP</th>
            <th>Version</th>
            <th>Operator</th>
            <th>Started</th>
            <th>Progress</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <Link href={`/checklists/${r.id}`}>
                  {r.sop.referenceNo} — {r.sop.name}
                </Link>
              </td>
              <td>v{r.version.label}</td>
              <td>{r.operator?.name ?? '—'}</td>
              <td>{fmtDateTime(r.startedAt)}</td>
              <td>
                {r.answered}/{r.totalSteps} {r.notOk > 0 && <span className="badge badge-red">{r.notOk} NOT OK</span>}
              </td>
              <td>
                <span className={`badge ${STATUS_CLS[r.status]}`}>{r.status.replace('_', ' ')}</span>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                No checklists yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
