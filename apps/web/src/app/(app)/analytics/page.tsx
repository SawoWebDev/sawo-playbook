'use client';

import { Loading } from '@/components/feedback/Loading';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/format';
import { Avatar } from '@/components/users/Avatar';

interface Summary {
  scope: 'organization' | 'own';
  from: string;
  to: string;
  totals: { sopsByStatus: Record<string, number>; kanbans: number; activeUsers: number | null; completedChecklists: number };
  events: { eventType: string; count: number }[];
  daily: { day: string; views: number; edits: number; created: number; checklists: number }[];
  topSops: { sop: { id: string; name: string; referenceNo: string }; views: number }[];
  topActors: { user: { id: string; name: string }; events: number }[];
}

const SERIES = [
  { key: 'views', label: 'SOP views', color: '#8c5e38' },
  { key: 'edits', label: 'Edits', color: '#c9a882' },
  { key: 'created', label: 'Created', color: '#5a7d6b' },
  { key: 'checklists', label: 'Checklists', color: '#d9a441' },
] as const;

const PERIODS = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '12 months' },
];

function DailyChart({ daily, from, to }: { daily: Summary['daily']; from: string; to: string }) {
  const byDay = new Map(daily.map((d) => [d.day.slice(0, 10), d]));
  const days: string[] = [];
  for (let t = new Date(from.slice(0, 10)).getTime(); t <= new Date(to).getTime(); t += 86_400_000) days.push(new Date(t).toISOString().slice(0, 10));
  const max = Math.max(1, ...daily.map((d) => d.views + d.edits + d.created + d.checklists));
  const w = 720;
  const hgt = 160;
  const bw = w / Math.max(days.length, 1);
  return (
    <svg viewBox={`0 0 ${w} ${hgt + 20}`} width="100%" role="img" aria-label="Daily activity">
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1={0} x2={w} y1={hgt - f * (hgt - 10)} y2={hgt - f * (hgt - 10)} stroke="#f1ebe4" />
      ))}
      {days.map((day, i) => {
        const d = byDay.get(day);
        let y = hgt;
        return (
          <g key={day}>
            <title>
              {day}: {d ? SERIES.map((s) => `${s.label} ${d[s.key]}`).join(', ') : 'no activity'}
            </title>
            {SERIES.map((s) => {
              const v = d ? d[s.key] : 0;
              const bh = (v / max) * (hgt - 10);
              y -= bh;
              return v ? <rect key={s.key} x={i * bw + 1} y={y} width={Math.max(bw - 2, 1)} height={bh} fill={s.color} rx={2} /> : null;
            })}
            {(i === 0 || i === days.length - 1 || i % 7 === 0) && (
              <text x={i * bw + bw / 2} y={hgt + 14} fontSize={10} textAnchor="middle" fill="#9a8c7e">
                {day.slice(5)}
              </text>
            )}
          </g>
        );
      })}
      <line x1={0} x2={w} y1={hgt} y2={hgt} stroke="#e7dfd5" />
    </svg>
  );
}

/** A ranked list with a bar showing each row's share of the top value. */
function Ranked({ rows }: { rows: { key: string; label: React.ReactNode; value: number }[] }) {
  const top = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ol className="an-rank">
      {rows.map((r, i) => (
        <li key={r.key}>
          <span className="an-rank-n">{i + 1}</span>
          <div className="an-rank-body">
            <div className="an-rank-row">
              <span className="an-rank-label">{r.label}</span>
              <span className="an-rank-value">{r.value}</span>
            </div>
            <div className="ui-progress">
              <span style={{ width: `${Math.round((r.value / top) * 100)}%` }} />
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

export default function AnalyticsPage() {
  const [days, setDays] = useState(30);
  const [s, setS] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    api<Summary>(`/analytics/summary?from=${from.toISOString()}&to=${to.toISOString()}`)
      .then(setS)
      .catch((e) => setError(errorMessage(e)));
  }, [days]);

  const head = (
    <div className="page-head">
      <span className="grp-chip">
        <i className={`fa-solid ${s?.scope === 'own' ? 'fa-user' : 'fa-building'}`} aria-hidden style={{ marginRight: 6 }} />
        {s?.scope === 'own' ? 'Your activity' : 'Whole organization'}
      </span>
      <div className="page-head-actions">
        <div className="ui-seg" role="group" aria-label="Period">
          {PERIODS.map((p) => (
            <button key={p.days} type="button" className={days === p.days ? 'is-on' : ''} aria-pressed={days === p.days} onClick={() => setDays(p.days)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  if (error) return <div className="error">{error}</div>;
  if (!s) return <>{head}<Loading /></>;

  const tiles: { label: string; value: number; icon: string }[] = [
    { label: 'Published SOPs', value: s.totals.sopsByStatus.published ?? 0, icon: 'fa-file-circle-check' },
    {
      label: 'Drafts / in review',
      value: (s.totals.sopsByStatus.draft ?? 0) + (s.totals.sopsByStatus.pending_approval ?? 0) + (s.totals.sopsByStatus.approved ?? 0),
      icon: 'fa-file-pen',
    },
    { label: 'Kanban cards', value: s.totals.kanbans, icon: 'fa-table-columns' },
    { label: 'Completed checklists', value: s.totals.completedChecklists, icon: 'fa-list-check' },
  ];
  if (s.totals.activeUsers !== null) tiles.push({ label: 'Active users', value: s.totals.activeUsers, icon: 'fa-users' });

  return (
    <>
      {head}

      <div className="kpi-grid">
        {tiles.map((t) => (
          <div key={t.label} className="kpi">
            <span className="kpi-icon"><i className={`fa-solid ${t.icon}`} aria-hidden /></span>
            <span className="kpi-text">
              <span className="kpi-value">{t.value}</span>
              <span className="kpi-label">{t.label}</span>
            </span>
          </div>
        ))}
      </div>

      <section className="card an-chart">
        <div className="an-card-head">
          <h3>Daily activity</h3>
          <div className="an-legend">
            {SERIES.map((x) => (
              <span key={x.key}>
                <span className="an-dot" style={{ background: x.color }} /> {x.label}
              </span>
            ))}
          </div>
        </div>
        <DailyChart daily={s.daily} from={s.from} to={s.to} />
      </section>

      <div className="an-grid">
        <section className="card">
          <div className="an-card-head">
            <h3>Most viewed SOPs</h3>
          </div>
          {s.topSops.length === 0 ? (
            <p className="muted">No views in this period.</p>
          ) : (
            <Ranked
              rows={s.topSops.map((t) => ({
                key: t.sop.id,
                value: t.views,
                label: (
                  <Link href={`/sops/${t.sop.id}`} title={t.sop.name}>
                    <span className="muted">{t.sop.referenceNo}</span> {t.sop.name}
                  </Link>
                ),
              }))}
            />
          )}
        </section>
        {s.scope === 'organization' && (
          <section className="card">
            <div className="an-card-head">
              <h3>Most active users</h3>
            </div>
            {s.topActors.length === 0 ? (
              <p className="muted">No activity in this period.</p>
            ) : (
              <Ranked
                rows={s.topActors.map((t) => ({
                  key: t.user.id,
                  value: t.events,
                  label: (
                    <span className="an-user">
                      <Avatar name={t.user.name} size={22} /> {t.user.name}
                    </span>
                  ),
                }))}
              />
            )}
          </section>
        )}
        <section className="card">
          <div className="an-card-head">
            <h3>Events</h3>
          </div>
          {s.events.length === 0 ? (
            <p className="muted">No events in this period.</p>
          ) : (
            <Ranked rows={s.events.map((e) => ({ key: e.eventType, value: e.count, label: <span className="ui-code">{e.eventType}</span> }))} />
          )}
        </section>
      </div>
    </>
  );
}
