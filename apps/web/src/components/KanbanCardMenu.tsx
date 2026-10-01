'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import type { Kanban } from '@/components/KanbanForm';
import { Icons } from '@/components/Subbar';
import { api, apiRaw } from '@/lib/api';
import { errorMessage, fmtDateTime } from '@/lib/format';

interface HistoryRow {
  id: string;
  action: string;
  by: string | null;
  at: string;
}

/** "•••" dropdown on a kanban list card: edit, delete, duplicate, change history and PDF. */
export function KanbanCardMenu({
  kanban: k,
  canEdit,
  onChanged,
  onError,
}: {
  kanban: Kanban;
  canEdit: boolean;
  onChanged: (notice?: string) => void;
  onError: (msg: string) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const [history, setHistory] = useState(false);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setOpen(false);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const remove = () => {
    if (!confirm(`Delete kanban card ${k.partCode}?`)) return setOpen(false);
    void run(async () => {
      await api(`/kanbans/${k.id}`, { method: 'DELETE' });
      onChanged(`Deleted ${k.partCode}.`);
    });
  };

  const printPdf = () =>
    run(async () => {
      const res = await apiRaw('/kanbans/bulk/print', { method: 'POST', body: { ids: [k.id] } });
      if (!res.ok) throw new Error(`Print failed (${res.status})`);
      const url = URL.createObjectURL(await res.blob());
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    });

  return (
    <div className="menu kanban-more" onClick={(e) => e.stopPropagation()}>
      <button
        className="more"
        aria-label={`Actions for ${k.partCode}`}
        aria-expanded={open}
        disabled={busy}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setUp(window.innerHeight - r.bottom < 300 && r.top > window.innerHeight - r.bottom);
          setOpen((o) => !o);
        }}
      >
        •••
      </button>
      {open && (
        <div className={`menu-list icon-menu${up ? ' up' : ''}`} onMouseLeave={() => setOpen(false)}>
          {canEdit && <Item icon={Icons.pencil} label="Edit" onClick={() => run(async () => router.push(`/kanbans/${k.id}/edit`))} />}
          {canEdit && <Item icon={Icons.trash} label="Delete" onClick={remove} />}
          {canEdit && <Item icon={Icons.copy} label="Duplicate" onClick={() => run(async () => router.push(`/kanbans/new?copy=${k.id}`))} />}
          <Item
            icon={Icons.history}
            label="Change History"
            onClick={() => {
              setOpen(false);
              setHistory(true);
            }}
          />
          <Item icon={Icons.eye} label="View or Print PDF" onClick={printPdf} />
        </div>
      )}
      {history && <ChangeHistory kanban={k} onClose={() => setHistory(false)} />}
    </div>
  );
}

function Item({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function ChangeHistory({ kanban: k, onClose }: { kanban: Kanban; onClose: () => void }) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<HistoryRow[]>(`/kanbans/${k.id}/history`)
      .then(setRows)
      .catch((e) => setError(errorMessage(e)));
  }, [k.id]);
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="card dialog" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 2px' }}>Change History</h3>
        <p className="muted" style={{ margin: '0 0 12px', fontSize: 13 }}>
          {k.partCode}
          {k.partDescription ? ` — ${k.partDescription}` : ''}
        </p>
        {error && <div className="error">{error}</div>}
        {!rows && !error && <p className="muted">Loading…</p>}
        {rows && (
          <div className="dialog-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Change</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{fmtDateTime(r.at)}</td>
                    <td>{r.action}</td>
                    <td>{r.by ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
