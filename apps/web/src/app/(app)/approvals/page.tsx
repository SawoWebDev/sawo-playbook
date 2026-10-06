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

const FILTER_ICON: Partial<Record<FilterKey, string>> = {
  all: 'fa-layer-group',
  needs: 'fa-hand-pointer',
  blocked: 'fa-ban',
  pre: 'fa-clipboard-check',
  final: 'fa-circle-check',
  ready: 'fa-paper-plane',
  rejected: 'fa-rotate-left',
  mine: 'fa-user',
};

function Quorum({ item }: { item: ApprovalItem }) {
  if (item.kind !== 'sop' || !item.quorum) return <span className="muted">—</span>;
  const q = item.quorum;
  const pct = q.required ? Math.min(100, Math.round((q.current / q.required) * 100)) : 0;
  return (
    <div className="ap-quorum" title="Distinct final approvals against the quorum">
      <span>
        {q.current} of {q.required}
      </span>
      <div className={`ui-progress${q.current >= q.required ? ' is-done' : ''}`}>
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default function ApprovalCenterPage() {
  const [items, setItems] = useState<ApprovalItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>('needs');
  const [kind, setKind] = useState<'all' | 'sop' | 'kanban'>('all');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setItems(await loadApprovalItems());
  }, []);

  useEffect(() => {
    load().catch((e) => setError(errorMessage(e)));
  }, [load]);

  const refresh = () => {
    setRefreshing(true);
    load()
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setRefreshing(false));
  };

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
      <div className="page-head">
        <p className="page-lead">
          Everything you can act on, is blocked, or you submitted. The server builds this list for your permissions and groups.
        </p>
        <div className="page-head-actions">
          <div className="ui-seg" role="group" aria-label="Filter by type">
            {(
              [
                ['all', 'All types', 'fa-layer-group'],
                ['sop', 'STD OPS', 'fa-file-lines'],
                ['kanban', 'Kanbans', 'fa-table-columns'],
              ] as const
            ).map(([k, label, icon]) => (
              <button key={k} type="button" className={kind === k ? 'is-on' : ''} aria-pressed={kind === k} onClick={() => setKind(k)}>
                <i className={`fa-solid ${icon}`} aria-hidden /> {label}
              </button>
            ))}
          </div>
          <button className="btn" type="button" onClick={refresh} disabled={refreshing}>
            <i className={`fa-solid fa-rotate${refreshing ? ' fa-spin' : ''}`} aria-hidden /> Refresh
          </button>
        </div>
      </div>

      {items && (
        <div className="kpi-grid">
          <div className={`kpi${counts.needs ? ' kpi-good' : ''}`}>
            <span className="kpi-icon"><i className="fa-solid fa-hand-pointer" aria-hidden /></span>
            <span className="kpi-text"><span className="kpi-value">{counts.needs}</span><span className="kpi-label">Need my action</span></span>
          </div>
          <div className={`kpi${counts.blocked ? ' kpi-warn' : ''}`}>
            <span className="kpi-icon"><i className="fa-solid fa-ban" aria-hidden /></span>
            <span className="kpi-text"><span className="kpi-value">{counts.blocked}</span><span className="kpi-label">Blocked</span></span>
          </div>
          <div className="kpi">
            <span className="kpi-icon"><i className="fa-solid fa-paper-plane" aria-hidden /></span>
            <span className="kpi-text"><span className="kpi-value">{counts.ready}</span><span className="kpi-label">Ready to publish</span></span>
          </div>
          <div className="kpi">
            <span className="kpi-icon"><i className="fa-solid fa-user" aria-hidden /></span>
            <span className="kpi-text"><span className="kpi-value">{counts.mine}</span><span className="kpi-label">Submitted by me</span></span>
          </div>
        </div>
      )}

      {error && <div className="error" role="alert">{error}</div>}

      <div className="ui-seg ap-filters" role="group" aria-label="Approval filters">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" className={filter === f.key ? 'is-on' : ''} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
            <i className={`fa-solid ${FILTER_ICON[f.key] ?? 'fa-filter'}`} aria-hidden /> {f.label} <span className="ui-count">{counts[f.key] ?? 0}</span>
          </button>
        ))}
      </div>

      {items === null && !error && <p className="muted" role="status">Loading approvals…</p>}

      {items !== null && (
        <div className="um-card">
          {visible.length === 0 ? (
            <div className="um-empty">
              <i className="fa-solid fa-inbox" aria-hidden />
              <p>
                {items.length === 0
                  ? 'Nothing is waiting for approval right now.'
                  : filter === 'needs'
                    ? 'Nothing needs your action. Items appear here when you are eligible to act on them.'
                    : 'Nothing matches this filter.'}
              </p>
            </div>
          ) : (
            <>
              <div className="um-table-wrap">
                <table className="um-table">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Stage</th>
                      <th>Submitted</th>
                      <th>Routed to</th>
                      <th>Quorum</th>
                      <th>Status</th>
                      <th aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((i) => {
                      const s = statusOf(i);
                      const action = availableAction(i);
                      const href = i.kind === 'sop' ? `/approvals/sop/${i.parentId}/${i.id}` : `/approvals/kanban/${i.id}`;
                      return (
                        <tr key={i.key}>
                          <td>
                            <div className="ap-item">
                              <span className="kpi-icon ap-kind" title={i.kind === 'sop' ? 'STD OPS' : 'Kanban'}>
                                <i className={`fa-solid ${i.kind === 'sop' ? 'fa-file-lines' : 'fa-table-columns'}`} aria-hidden />
                              </span>
                              <div className="grp-member-info">
                                <Link href={href} className="ap-title">{i.title}</Link>
                                <span className="muted grp-member-email">
                                  {i.kind === 'sop' ? 'STD OPS' : 'Kanban'}
                                  {i.reference ? ` · ${i.reference}` : ''}
                                </span>
                                {i.sections.has('blocked') && i.blockedReason && <div className="error">{i.blockedReason}</div>}
                                {i.sections.has('rejected') && i.comment && <div className="muted ap-note">Reason: {i.comment}</div>}
                              </div>
                            </div>
                          </td>
                          <td className="um-nowrap">{STATE_LABEL[i.state] ?? i.state}</td>
                          <td>
                            <div className="grp-member-info">
                              <span>{i.submitter ?? <span className="muted">—</span>}</span>
                              <span className="muted grp-member-email">{i.submittedAt ? fmtDate(i.submittedAt) : ''}</span>
                            </div>
                          </td>
                          <td>
                            {i.kind === 'sop' && i.groupNames ? (
                              i.groupNames.length === 0 ? (
                                <span className="muted">Organisation-wide</span>
                              ) : (
                                <div className="um-groups">
                                  {i.groupNames.slice(0, 2).map((g) => (
                                    <span key={g} className="grp-chip">{g}</span>
                                  ))}
                                  {i.groupNames.length > 2 && <span className="grp-chip um-chip-more">+{i.groupNames.length - 2}</span>}
                                </div>
                              )
                            ) : i.groupCount === 0 ? (
                              <span className="muted">Organisation-wide</span>
                            ) : (
                              plural(i.groupCount, 'group')
                            )}
                          </td>
                          <td><Quorum item={i} /></td>
                          <td><span className={`badge ${s.className}`}>{s.label}</span></td>
                          <td className="ap-action">
                            {action ? (
                              <Link className="btn btn-sm btn-primary" href={href} title={action}>
                                {action.startsWith('Approve (') ? 'Approve' : action}
                              </Link>
                            ) : (
                              <Link className="btn btn-sm" href={href}>Open</Link>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="um-card-foot muted">Showing {plural(visible.length, 'item')}</div>
            </>
          )}
        </div>
      )}
    </>
  );
}
