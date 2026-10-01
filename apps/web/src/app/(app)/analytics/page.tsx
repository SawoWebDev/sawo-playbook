'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/format';

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
  { key: 'views', label: 'SOP views', color: 'var(--primary)' },
  { key: 'edits', label: 'Edits', color: '#a97d53' },
  { key: 'created', label: 'Created', color: 'var(--success)' },
  { key: 'checklists', label: 'Checklists', color: 'var(--warning)' },
] as const;

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
              return v ? <rect key={s.key} x={i * bw + 1} y={y} width={Math.max(bw - 2, 1)} height={bh} fill={s.color} rx={1} /> : null;
            })}
            {(i === 0 || i === days.length - 1 || i % 7 === 0) && (
              <text x={i * bw + bw / 2} y={hgt + 14} fontSize={10} textAnchor="middle" fill="var(--muted)">
                {day.slice(5)}
              </text>
            )}
          </g>
        );
      })}
      <line x1={0} x2={w} y1={hgt} y2={hgt} stroke="var(--border)" />
    </svg>
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

  if (error) return <div className="error">{error}</div>;
  if (!s) return <p className="muted">Loading…</p>;

  const tiles: [string, number | string][] = [
    ['Published SOPs', s.totals.sopsByStatus.published ?? 0],
    ['Drafts / in review', (s.totals.sopsByStatus.draft ?? 0) + (s.totals.sopsByStatus.pending_approval ?? 0) + (s.totals.sopsByStatus.approved ?? 0)],
    ['Kanban cards', s.totals.kanbans],
    ['Completed checklists', s.totals.completedChecklists],
  ];
  if (s.totals.activeUsers !== null) tiles.push(['Active users', s.totals.activeUsers]);

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>Analytics</h1>
        <span className="badge">{s.scope === 'own' ? 'Your activity' : 'Whole organization'}</span>
        <div className="spacer" />
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 160 }}>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={365}>Last 12 months</option>
        </select>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', marginBottom: 16 }}>
        {tiles.map(([label, v]) => (
          <div key={label} className="card">
            <div className="muted" style={{ fontSize: 12 }}>
              {label}
            </div>
            <div style={{ fontSize: 26, fontWeight: 700 }}>{v}</div>
          </div>
        ))}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row" style={{ marginBottom: 8 }}>
          <strong>Daily activity</strong>
          <div className="spacer" />
          {SERIES.map((x) => (
            <span key={x.key} className="row" style={{ gap: 4, fontSize: 12 }}>
              <span style={{ width: 10, height: 10, background: x.color, borderRadius: 2, display: 'inline-block' }} /> {x.label}
            </span>
          ))}
        </div>
        <DailyChart daily={s.daily} from={s.from} to={s.to} />
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Most viewed SOPs</h3>
          {s.topSops.length === 0 && <p className="muted">No views in this period.</p>}
          <ol style={{ margin: 0, paddingLeft: 20 }}>
            {s.topSops.map((t) => (
              <li key={t.sop.id}>
                <Link href={`/sops/${t.sop.id}`}>
                  {t.sop.referenceNo} — {t.sop.name}
                </Link>{' '}
                <span className="muted">({t.views})</span>
              </li>
            ))}
          </ol>
        </div>
        {s.scope === 'organization' && (
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Most active users</h3>
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              {s.topActors.map((t) => (
                <li key={t.user.id}>
                  {t.user.name} <span className="muted">({t.events})</span>
                </li>
              ))}
            </ol>
          </div>
        )}
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Events</h3>
          <table className="table" style={{ border: 0 }}>
            <tbody>
              {s.events.map((e) => (
                <tr key={e.eventType}>
                  <td>
                    <code>{e.eventType}</code>
                  </td>
                  <td style={{ textAlign: 'right' }}>{e.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
