'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { errorMessage, fmtDateTime, plural } from '@/lib/format';
import { Avatar } from '@/components/users/Avatar';

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

const STATUS = {
  in_progress: { label: 'In progress', cls: 'badge-amber', icon: 'fa-spinner' },
  completed: { label: 'Completed', cls: 'badge-green', icon: 'fa-circle-check' },
  abandoned: { label: 'Abandoned', cls: '', icon: 'fa-circle-xmark' },
} as const;

type StatusKey = keyof typeof STATUS;

export default function ChecklistsPage() {
  const [rows, setRows] = useState<ChecklistRow[] | null>(null);
  const [status, setStatus] = useState<'' | StatusKey>('');
  const [error, setError] = useState<string | null>(null);

  // All runs are loaded once; the status chips filter on the client so their counts stay visible.
  useEffect(() => {
    api<ChecklistRow[]>('/checklists')
      .then(setRows)
      .catch((e) => setError(errorMessage(e)));
  }, []);

  const counts = useMemo(() => {
    const c: Record<string, number> = { '': rows?.length ?? 0 };
    for (const r of rows ?? []) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [rows]);

  const visible = (rows ?? []).filter((r) => !status || r.status === status);
  const withIssues = (rows ?? []).filter((r) => r.notOk > 0).length;

  return (
    <>
      <p className="page-lead">Checklist runs recorded against published SOPs. Start a run from any SOP set up as a Checklist SOP.</p>

      {rows && (
        <div className="kpi-grid">
          <div className="kpi">
            <span className="kpi-icon"><i className="fa-solid fa-list-check" aria-hidden /></span>
            <span className="kpi-text"><span className="kpi-value">{rows.length}</span><span className="kpi-label">Runs</span></span>
          </div>
          <div className="kpi">
            <span className="kpi-icon"><i className="fa-solid fa-spinner" aria-hidden /></span>
            <span className="kpi-text"><span className="kpi-value">{counts.in_progress ?? 0}</span><span className="kpi-label">In progress</span></span>
          </div>
          <div className="kpi kpi-good">
            <span className="kpi-icon"><i className="fa-solid fa-circle-check" aria-hidden /></span>
            <span className="kpi-text"><span className="kpi-value">{counts.completed ?? 0}</span><span className="kpi-label">Completed</span></span>
          </div>
          <div className={`kpi${withIssues ? ' kpi-warn' : ''}`}>
            <span className="kpi-icon"><i className="fa-solid fa-triangle-exclamation" aria-hidden /></span>
            <span className="kpi-text"><span className="kpi-value">{withIssues}</span><span className="kpi-label">With NOT OK steps</span></span>
          </div>
        </div>
      )}

      <div className="ui-seg au-filters" role="group" aria-label="Filter by status">
        <button type="button" className={status === '' ? 'is-on' : ''} aria-pressed={status === ''} onClick={() => setStatus('')}>
          All <span className="ui-count">{counts[''] ?? 0}</span>
        </button>
        {(Object.keys(STATUS) as StatusKey[]).map((k) => (
          <button key={k} type="button" className={status === k ? 'is-on' : ''} aria-pressed={status === k} onClick={() => setStatus(k)}>
            <i className={`fa-solid ${STATUS[k].icon}`} aria-hidden /> {STATUS[k].label} <span className="ui-count">{counts[k] ?? 0}</span>
          </button>
        ))}
      </div>

      {error && <div className="error">{error}</div>}
      {rows === null && !error && <p className="muted" role="status">Loading checklists…</p>}

      {rows !== null && (
        <div className="um-card">
          {visible.length === 0 ? (
            <div className="um-empty">
              <i className="fa-solid fa-list-check" aria-hidden />
              <p>{rows.length === 0 ? 'No checklists yet.' : 'No checklists with this status.'}</p>
            </div>
          ) : (
            <>
              <div className="um-table-wrap">
                <table className="um-table">
                  <thead>
                    <tr>
                      <th>SOP</th>
                      <th>Operator</th>
                      <th>Started</th>
                      <th>Progress</th>
                      <th>Status</th>
                      <th aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((r) => {
                      const pct = r.totalSteps ? Math.round((r.answered / r.totalSteps) * 100) : 0;
                      return (
                        <tr key={r.id}>
                          <td>
                            <div className="grp-member-info">
                              <Link href={`/checklists/${r.id}`} className="ap-title">{r.sop.name}</Link>
                              <span className="muted grp-member-email">
                                {r.sop.referenceNo} · v{r.version.label}
                              </span>
                            </div>
                          </td>
                          <td>
                            {r.operator ? (
                              <div className="um-person au-actor">
                                <Avatar name={r.operator.name} size={28} />
                                <span>{r.operator.name}</span>
                              </div>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                          <td className="muted um-nowrap">{fmtDateTime(r.startedAt)}</td>
                          <td>
                            <div className="ck-progress">
                              <div className={`ui-progress${r.status === 'completed' ? ' is-done' : ''}`}>
                                <span style={{ width: `${pct}%` }} />
                              </div>
                              <span className="muted">
                                {r.answered}/{r.totalSteps}
                              </span>
                              {r.notOk > 0 && <span className="badge badge-red">{r.notOk} NOT OK</span>}
                            </div>
                          </td>
                          <td><span className={`badge ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span></td>
                          <td className="ap-action">
                            <Link className="btn btn-sm" href={`/checklists/${r.id}`}>
                              {r.status === 'in_progress' ? 'Continue' : 'View'}
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="um-card-foot muted">Showing {plural(visible.length, 'run')}</div>
            </>
          )}
        </div>
      )}
    </>
  );
}
