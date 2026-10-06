'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errorMessage, fmtDateTime } from '@/lib/format';
import { Avatar } from '@/components/users/Avatar';

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

/** Event families the API filters by (action prefix). */
const FILTERS = [
  { value: '', label: 'All events', icon: 'fa-layer-group' },
  { value: 'auth.', label: 'Authentication', icon: 'fa-key' },
  { value: 'user.', label: 'Users', icon: 'fa-users' },
  { value: 'org.', label: 'Organization', icon: 'fa-building' },
  { value: 'sop.', label: 'SOP approvals', icon: 'fa-file-lines' },
  { value: 'kanban.', label: 'Kanbans', icon: 'fa-table-columns' },
  { value: 'skills.', label: 'Skills', icon: 'fa-certificate' },
];

const familyIcon = (action: string) => FILTERS.find((f) => f.value && action.startsWith(f.value))?.icon ?? 'fa-circle-info';

/** Metadata as short key/value tags. Nested values are shown as compact JSON. */
function Details({ metadata }: { metadata: Record<string, unknown> }) {
  const entries = Object.entries(metadata ?? {});
  if (!entries.length) return <span className="muted">—</span>;
  return (
    <div className="ui-kv">
      {entries.map(([k, v]) => {
        const text = v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);
        return (
          <span key={k} title={`${k}: ${text}`}>
            <b>{k}</b> {text}
          </span>
        );
      })}
    </div>
  );
}

export default function AuditPage() {
  const [items, setItems] = useState<AuditItem[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(
    async (before?: string) => {
      try {
        const q = new URLSearchParams({ limit: '50' });
        if (filter) q.set('action', filter);
        if (before) q.set('before', before);
        const r = await api<{ items: AuditItem[]; nextBefore: string | null }>(`/audit-log?${q}`);
        setItems((prev) => (before ? [...(prev ?? []), ...r.items] : r.items));
        setNext(r.nextBefore);
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [filter],
  );

  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);

  return (
    <>
      <p className="page-lead">Every sign-in, permission change and approval decision in this organisation, newest first.</p>

      <div className="ui-seg au-filters" role="group" aria-label="Filter events">
        {FILTERS.map((f) => (
          <button key={f.value} type="button" className={filter === f.value ? 'is-on' : ''} aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}>
            <i className={`fa-solid ${f.icon}`} aria-hidden /> {f.label}
          </button>
        ))}
      </div>

      {error && <div className="error">{error}</div>}
      {items === null && !error && <p className="muted" role="status">Loading events…</p>}

      {items !== null && (
        <div className="um-card">
          {items.length === 0 ? (
            <div className="um-empty">
              <i className="fa-solid fa-clipboard-list" aria-hidden />
              <p>No events recorded for this filter.</p>
            </div>
          ) : (
            <div className="um-table-wrap">
              <table className="um-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Event</th>
                    <th>Actor</th>
                    <th>Entity</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id}>
                      <td className="um-nowrap muted">{fmtDateTime(i.occurredAt)}</td>
                      <td>
                        <span className="au-event">
                          <i className={`fa-solid ${familyIcon(i.action)}`} aria-hidden />
                          <span className="ui-code">{i.action}</span>
                        </span>
                      </td>
                      <td>
                        {i.actor ? (
                          <div className="um-person au-actor">
                            <Avatar name={i.actor.name} size={28} />
                            <div className="grp-member-info">
                              <span className="grp-member-name">{i.actor.name}</span>
                              <span className="muted grp-member-email">{i.actor.email}</span>
                            </div>
                          </div>
                        ) : (
                          <span className="muted">System</span>
                        )}
                      </td>
                      <td className="muted">{i.entityType ?? '—'}</td>
                      <td><Details metadata={i.metadata} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {items.length > 0 && (
            <div className="um-card-foot muted au-foot">
              <span>Showing {items.length} events</span>
              {next && (
                <button
                  className="btn btn-sm"
                  disabled={loadingMore}
                  onClick={() => {
                    setLoadingMore(true);
                    void load(next).finally(() => setLoadingMore(false));
                  }}
                >
                  {loadingMore ? 'Loading…' : 'Load older events'}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}
