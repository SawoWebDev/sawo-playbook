'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage, fmtDate, fmtDateTime } from '@/lib/format';
import { hasPermission, roleLabel } from '@/lib/permissions';
import type { Role } from '@/lib/api';

interface Matrix {
  levels: { value: number; label: string }[];
  sops: { id: string; name: string; referenceNo: string; currentVersionId: string; currentVersionLabel: string }[];
  associates: { id: string; name: string; role: Role; editable: boolean }[];
  cells: { associateId: string; sopId: string; level: number; sopVersionId: string; versionLabel: string; outdated: boolean; assessedAt: string }[];
}

interface HistoryRow {
  id: string;
  associate: { id: string; name: string };
  trainer: { id: string; name: string };
  sop: { id: string; name: string; referenceNo: string };
  versionLabel: string;
  level: number;
  levelLabel: string;
  assessedAt: string;
  notes: string | null;
}

/** Quarter-filled circle per competency level (0–4), the classic skills-matrix glyph. */
function LevelGlyph({ level, size = 26 }: { level: number; size?: number }) {
  const r = size / 2 - 2;
  const c = size / 2;
  const quarters = [
    `M${c},${c} L${c},${c - r} A${r},${r} 0 0,1 ${c + r},${c} Z`,
    `M${c},${c} L${c + r},${c} A${r},${r} 0 0,1 ${c},${c + r} Z`,
    `M${c},${c} L${c},${c + r} A${r},${r} 0 0,1 ${c - r},${c} Z`,
    `M${c},${c} L${c - r},${c} A${r},${r} 0 0,1 ${c},${c - r} Z`,
  ];
  return (
    <svg width={size} height={size} aria-label={`Level ${level}`}>
      <circle cx={c} cy={c} r={r} fill="var(--surface)" stroke="var(--text)" strokeWidth={1.5} />
      {quarters.slice(0, level).map((d, i) => (
        <path key={i} d={d} fill={level === 4 ? 'var(--success)' : 'var(--primary)'} />
      ))}
    </svg>
  );
}

export default function SkillsPage() {
  const { user } = useAuth();
  const [m, setM] = useState<Matrix | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [editing, setEditing] = useState<{ associateId: string; sopId: string } | null>(null);
  const [level, setLevel] = useState(0);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const canUpdate = hasPermission(user, 'skills.update');

  const load = useCallback(async () => {
    try {
      const [matrix, hist] = await Promise.all([api<Matrix>('/skills/matrix'), api<HistoryRow[]>('/skills/history')]);
      setM(matrix);
      setHistory(hist);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [canUpdate]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !m) return <div className="error">{error}</div>;
  if (!m) return <p className="muted">Loading…</p>;

  const cellOf = (associateId: string, sopId: string) => m.cells.find((c) => c.associateId === associateId && c.sopId === sopId);
  const editingAssociate = editing && m.associates.find((a) => a.id === editing.associateId);
  const editingSop = editing && m.sops.find((s) => s.id === editing.sopId);

  async function save() {
    if (!editing) return;
    try {
      await api('/skills/assessments', { method: 'POST', body: { ...editing, level, notes: notes || undefined } });
      setEditing(null);
      setNotes('');
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <>

      {error && <div className="error">{error}</div>}
      <div className="row" style={{ marginBottom: 12, gap: 16 }}>
        {m.levels.map((l) => (
          <span key={l.value} className="row" style={{ gap: 4 }}>
            <LevelGlyph level={l.value} size={20} /> <span className="muted">{l.value} — {l.label}</span>
          </span>
        ))}
      </div>

      {m.sops.length === 0 ? (
        <p className="muted">Publish SOPs to track skills against them.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="table skills-matrix">
            <thead>
              <tr>
                <th>Associate</th>
                {m.sops.map((s) => (
                  <th key={s.id} title={`${s.name} (v${s.currentVersionLabel})`}>
                    <div className="skills-col">{s.referenceNo}</div>
                    <div className="muted" style={{ fontWeight: 400, fontSize: 11, maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {s.name}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {m.associates.map((a) => (
                <tr key={a.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {a.name} <span className="muted">· {roleLabel(a.role)}</span>
                  </td>
                  {m.sops.map((s) => {
                    const c = cellOf(a.id, s.id);
                    return (
                      <td key={s.id} style={{ textAlign: 'center' }}>
                        <button
                          className="skill-cell"
                          disabled={!a.editable}
                          title={c ? `Level ${c.level} on v${c.versionLabel} · ${fmtDate(c.assessedAt)}${c.outdated ? ' · newer version published — reassess' : ''}` : 'Not assessed'}
                          onClick={() => {
                            setEditing({ associateId: a.id, sopId: s.id });
                            setLevel(c?.level ?? 0);
                          }}
                        >
                          <LevelGlyph level={c?.level ?? 0} />
                          {c?.outdated && <span className="outdated-dot" />}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: 12 }}>
            <span className="outdated-dot" style={{ position: 'static', display: 'inline-block' }} /> assessed against an older version of the SOP — reassessment recommended.
          </p>
        </div>
      )}

      <h2>Training history</h2>
      <table className="table">
        <thead>
          <tr>
            <th>When</th>
            <th>Associate</th>
            <th>SOP</th>
            <th>Version</th>
            <th>Level</th>
            <th>Trainer</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {history.slice(0, 100).map((h) => (
            <tr key={h.id}>
              <td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(h.assessedAt)}</td>
              <td>{h.associate.name}</td>
              <td>{h.sop.referenceNo}</td>
              <td>v{h.versionLabel}</td>
              <td className="row" style={{ gap: 4 }}>
                <LevelGlyph level={h.level} size={18} /> {h.levelLabel}
              </td>
              <td>{h.trainer.name}</td>
              <td className="muted">{h.notes}</td>
            </tr>
          ))}
          {history.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                No assessments yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {editing && editingAssociate && editingSop && (
        <div className="dialog-backdrop" onClick={() => setEditing(null)}>
          <div className="card dialog" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Assess {editingAssociate.name}</h3>
            <p className="muted">
              {editingSop.referenceNo} — {editingSop.name} (against v{editingSop.currentVersionLabel})
            </p>
            <div className="panel">
              {m.levels.map((l) => (
                <label key={l.value} className="row" style={{ fontWeight: 400, margin: 0 }}>
                  <input type="radio" name="level" style={{ width: 'auto' }} checked={level === l.value} onChange={() => setLevel(l.value)} />
                  <LevelGlyph level={l.value} size={20} /> {l.value} — {l.label}
                </label>
              ))}
            </div>
            <div className="field" style={{ marginTop: 12 }}>
              <label htmlFor="notes">Notes</label>
              <textarea id="notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
            <div className="row">
              <div className="spacer" />
              <button className="btn" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={save}>
                Record assessment
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
