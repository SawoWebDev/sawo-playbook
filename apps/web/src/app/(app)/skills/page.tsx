'use client';

import { useToast } from '@/components/feedback/Toast';

import { Loading } from '@/components/feedback/Loading';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage, fmtDate, fmtDateTime } from '@/lib/format';
import { hasPermission, roleLabel } from '@/lib/permissions';
import type { Role } from '@/lib/api';
import { Avatar } from '@/components/users/Avatar';

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
  const toast = useToast();
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
  if (!m) return <Loading />;

  const cellOf = (associateId: string, sopId: string) => m.cells.find((c) => c.associateId === associateId && c.sopId === sopId);
  const editingAssociate = editing && m.associates.find((a) => a.id === editing.associateId);
  const editingSop = editing && m.sops.find((s) => s.id === editing.sopId);

  async function save() {
    if (!editing) return;
    try {
      await api('/skills/assessments', { method: 'POST', body: { ...editing, level, notes: notes || undefined } });
      setEditing(null);
      setNotes('');
      toast.success('Assessment recorded.');
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  const outdated = m.cells.filter((c) => c.outdated).length;
  const expert = m.cells.filter((c) => c.level === 4).length;

  return (
    <>
      <div className="page-head">
        <div className="sk-legend" aria-label="Levels">
          {m.levels.map((l) => (
            <span key={l.value} className="sk-legend-item">
              <LevelGlyph level={l.value} size={18} /> <b>{l.value}</b> {l.label}
            </span>
          ))}
        </div>
      </div>

      <div className="kpi-grid">
        <div className="kpi">
          <span className="kpi-icon"><i className="fa-solid fa-users" aria-hidden /></span>
          <span className="kpi-text"><span className="kpi-value">{m.associates.length}</span><span className="kpi-label">Associates</span></span>
        </div>
        <div className="kpi">
          <span className="kpi-icon"><i className="fa-solid fa-file-lines" aria-hidden /></span>
          <span className="kpi-text"><span className="kpi-value">{m.sops.length}</span><span className="kpi-label">Published SOPs tracked</span></span>
        </div>
        <div className="kpi kpi-good">
          <span className="kpi-icon"><i className="fa-solid fa-award" aria-hidden /></span>
          <span className="kpi-text"><span className="kpi-value">{expert}</span><span className="kpi-label">At top level</span></span>
        </div>
        <div className={`kpi${outdated ? ' kpi-warn' : ''}`}>
          <span className="kpi-icon"><i className="fa-solid fa-clock-rotate-left" aria-hidden /></span>
          <span className="kpi-text"><span className="kpi-value">{outdated}</span><span className="kpi-label">Need reassessment</span></span>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {m.sops.length === 0 ? (
        <div className="um-card">
          <div className="um-empty">
            <i className="fa-solid fa-certificate" aria-hidden />
            <p>Publish SOPs to track skills against them.</p>
          </div>
        </div>
      ) : (
        <div className="um-card">
          <div className="um-table-wrap">
            <table className="um-table sk-matrix">
              <thead>
                <tr>
                  <th className="sk-sticky">Associate</th>
                  {m.sops.map((s) => (
                    <th key={s.id} title={`${s.name} (v${s.currentVersionLabel})`} className="sk-col">
                      <div className="skills-col">{s.referenceNo}</div>
                      <div className="sk-col-name">{s.name}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {m.associates.map((a) => (
                  <tr key={a.id}>
                    <td className="sk-sticky">
                      <div className="um-person au-actor">
                        <Avatar name={a.name} size={28} />
                        <div className="grp-member-info">
                          <span className="grp-member-name">{a.name}</span>
                          <span className="muted grp-member-email">{roleLabel(a.role)}</span>
                        </div>
                      </div>
                    </td>
                    {m.sops.map((s) => {
                      const c = cellOf(a.id, s.id);
                      return (
                        <td key={s.id} className="sk-cell-td">
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
          </div>
          <div className="um-card-foot muted">
            <span className="outdated-dot" style={{ position: 'static', display: 'inline-block', marginRight: 6 }} />
            Assessed against an older version of the SOP. Reassessment recommended.
            {canUpdate && ' Click a cell to record an assessment.'}
          </div>
        </div>
      )}

      <section className="ui-section">
        <div className="ui-section-head">
          <h3>Training history</h3>
          <span className="muted">{history.length > 100 ? 'Latest 100 assessments' : `${history.length} assessments`}</span>
        </div>
        <div className="um-card">
          {history.length === 0 ? (
            <div className="um-empty">
              <i className="fa-solid fa-clock-rotate-left" aria-hidden />
              <p>No assessments yet.</p>
            </div>
          ) : (
            <div className="um-table-wrap">
              <table className="um-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Associate</th>
                    <th>SOP</th>
                    <th>Level</th>
                    <th>Trainer</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {history.slice(0, 100).map((h) => (
                    <tr key={h.id}>
                      <td className="um-nowrap muted">{fmtDateTime(h.assessedAt)}</td>
                      <td>
                        <div className="um-person au-actor">
                          <Avatar name={h.associate.name} size={26} />
                          <span>{h.associate.name}</span>
                        </div>
                      </td>
                      <td>
                        <div className="grp-member-info">
                          <span className="grp-member-name">{h.sop.referenceNo}</span>
                          <span className="muted grp-member-email">v{h.versionLabel}</span>
                        </div>
                      </td>
                      <td>
                        <span className="sk-level">
                          <LevelGlyph level={h.level} size={18} /> {h.levelLabel}
                        </span>
                      </td>
                      <td>{h.trainer.name}</td>
                      <td className="muted">{h.notes || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {editing && editingAssociate && editingSop && (
        <div className="dialog-backdrop" onClick={() => setEditing(null)}>
          <div className="card dialog" role="dialog" aria-modal="true" aria-label={`Assess ${editingAssociate.name}`} onClick={(e) => e.stopPropagation()}>
            <div className="um-person" style={{ minWidth: 0, marginBottom: 12 }}>
              <Avatar name={editingAssociate.name} size={40} />
              <div className="grp-member-info">
                <h3 style={{ margin: 0 }}>Assess {editingAssociate.name}</h3>
                <span className="muted grp-member-email">
                  {editingSop.referenceNo} — {editingSop.name} (v{editingSop.currentVersionLabel})
                </span>
              </div>
            </div>
            <div className="sk-levels" role="radiogroup" aria-label="Level">
              {m.levels.map((l) => (
                <label key={l.value} className={`sk-level-opt${level === l.value ? ' is-on' : ''}`}>
                  <input type="radio" name="level" checked={level === l.value} onChange={() => setLevel(l.value)} />
                  <LevelGlyph level={l.value} size={22} />
                  <span>
                    <b>{l.value}</b> {l.label}
                  </span>
                </label>
              ))}
            </div>
            <div className="field" style={{ marginTop: 14 }}>
              <label htmlFor="notes">Notes</label>
              <textarea id="notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
            <div className="row">
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
