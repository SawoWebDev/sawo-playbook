'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { errorMessage, fmtDate, plural } from '@/lib/format';
import {
  FILTERS,
  isActionable,
  isReady,
  isWaiting,
  loadApprovalItems,
  matches,
  sortItems,
  STATE_LABEL,
  type ApprovalItem,
  type FilterKey,
} from '@/components/approvals/model';

/** Which single status badge an item shows. Blocked and actionable take precedence over the rest. */
function statusOf(i: ApprovalItem): { label: string; className: string } {
  if (isActionable(i)) return { label: 'Needs my action', className: 'badge-green' };
  if (i.sections.has('blocked')) return { label: 'Blocked', className: 'badge-red' };
  if (isReady(i)) return { label: 'Ready to publish', className: 'badge-blue' };
  if (isWaiting(i)) return { label: 'Waiting on approvers', className: 'badge-amber' };
  if (i.sections.has('rejected')) return { label: 'Rejected', className: 'badge-amber' };
  if (i.sections.has('mine')) return { label: 'Mine', className: 'badge-blue' };
  return { label: 'Pending', className: 'badge-blue' };
}

/** The action the server offered this item, as a label. Both kinds read the server's own action flags. */
function availableAction(i: ApprovalItem): string | null {
  const a = i.kind === 'sop' ? i.sopActions : i.kanbanActions;
  if (!a) return null;
  if (a.publish) return 'Publish';
  if (a.preApprove) return 'Pre-approve';
  if (a.approve) return i.state === 'PENDING_PRE_APPROVAL' ? 'Approve (skips pre-approval)' : 'Approve';
  return null;
}

function Quorum({ item }: { item: ApprovalItem }) {
  if (item.kind !== 'sop' || !item.quorum) return <span className="muted">—</span>;
  const q = item.quorum;
  return (
    <span title="Distinct final approvals against the quorum">
      {q.current} of {q.required}
    </span>
  );
}

export default function ApprovalCenterPage() {
  const [items, setItems] = useState<ApprovalItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>('needs');
  const [kind, setKind] = useState<'all' | 'sop' | 'kanban'>('all');

  const load = useCallback(async () => {
    setError(null);
    setItems(await loadApprovalItems());
  }, []);

  useEffect(() => {
    load().catch((e) => setError(errorMessage(e)));
  }, [load]);

  const counts = useMemo(() => {
    const all = items ?? [];
    return Object.fromEntries(FILTERS.map((f) => [f.key, all.filter((i) => matches(i, f.key)).length])) as Record<FilterKey, number>;
  }, [items]);

  const visible = useMemo(
    () => sortItems((items ?? []).filter((i) => matches(i, filter) && (kind === 'all' || i.kind === kind))),
    [items, filter, kind],
  );

  return (
    <>
      <h1>Approval Center</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Everything you can act on, is blocked, or submitted. The list is built by the server for your permissions and groups. Pre-approval, final approval and publishing each need the matching permission.
      </p>
      {error && <div className="error" role="alert">{error}</div>}

      <nav className="tabs" aria-label="Approval filters" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        {FILTERS.map((f) => (
          <button key={f.key} type="button" className={`btn btn-sm ${filter === f.key ? 'btn-primary' : ''}`} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
            {f.label} <span className="muted">({counts[f.key] ?? 0})</span>
          </button>
        ))}
      </nav>

      <div className="row" style={{ marginBottom: 12 }}>
        <label className="row" style={{ fontWeight: 400, margin: 0 }}>
          Type
          <select aria-label="Filter by type" value={kind} onChange={(e) => setKind(e.target.value as 'all' | 'sop' | 'kanban')}>
            <option value="all">All</option>
            <option value="sop">STD OPS</option>
            <option value="kanban">Kanban</option>
          </select>
        </label>
        <div className="spacer" />
        <button className="btn btn-sm" type="button" onClick={() => load().catch((e) => setError(errorMessage(e)))}>Refresh</button>
      </div>

      {items === null && !error && <p className="muted" role="status">Loading approvals…</p>}
      {items !== null && visible.length === 0 && (
        <p className="muted">
          {items.length === 0
            ? 'Nothing is waiting for approval right now.'
            : filter === 'needs'
              ? 'Nothing needs your action. Items appear here when you are eligible to act on them.'
              : 'Nothing matches this filter.'}
        </p>
      )}

      {items !== null && visible.length > 0 && (
        <>
          <p className="muted" style={{ fontSize: 13 }}>{plural(visible.length, 'item')}</p>
          <table className="table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Type</th>
                <th>Submitted by</th>
                <th>Submitted</th>
                <th>Stage</th>
                <th>Routed to</th>
                <th>Quorum</th>
                <th>Status</th>
                <th>Available</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((i) => {
                const s = statusOf(i);
                const href = i.kind === 'sop' ? `/approvals/sop/${i.parentId}/${i.id}` : `/approvals/kanban/${i.id}`;
                return (
                  <tr key={i.key}>
                    <td>
                      <div>{i.title}</div>
                      {i.reference && <div className="muted" style={{ fontSize: 12 }}>{i.reference}</div>}
                      {i.sections.has('blocked') && i.blockedReason && (
                        <div className="error" style={{ fontSize: 12, marginTop: 4 }}>{i.blockedReason}</div>
                      )}
                      {i.sections.has('rejected') && i.comment && (
                        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Reason: {i.comment}</div>
                      )}
                    </td>
                    <td>{i.kind === 'sop' ? 'STD OPS' : 'Kanban'}</td>
                    <td>{i.submitter ?? <span className="muted">—</span>}</td>
                    <td className="muted">{i.submittedAt ? fmtDate(i.submittedAt) : '—'}</td>
                    <td>{STATE_LABEL[i.state] ?? i.state}</td>
                    <td>
                      {i.kind === 'sop' && i.groupNames
                        ? i.groupNames.length === 0
                          ? <span className="muted">Organisation-wide</span>
                          : i.groupNames.join(', ')
                        : i.groupCount === 0
                          ? <span className="muted">Organisation-wide</span>
                          : plural(i.groupCount, 'group')}
                    </td>
                    <td><Quorum item={i} /></td>
                    <td><span className={`badge ${s.className}`}>{s.label}</span></td>
                    <td>{availableAction(i) ?? <span className="muted">None</span>}</td>
                    <td style={{ textAlign: 'right' }}>
                      <Link className="btn btn-sm" href={href}>Open</Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
