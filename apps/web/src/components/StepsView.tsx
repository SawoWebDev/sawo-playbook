import { fmtDuration } from '@/lib/format';
import type { Step } from '@/lib/types';

/** Read-only rendering of a version's steps. Descriptions are server-sanitised HTML (§7.8). */
export function StepsView({ steps, showTitles }: { steps: Step[]; showTitles?: boolean }) {
  if (steps.length === 0) return <p className="muted">This version has no steps yet.</p>;
  return (
    <ol className="steps">
      {steps.map((s) => (
        <li key={s.id} className={`step-card${s.isCritical ? ' critical' : ''}`}>
          <div className="step-head">
            <span className="step-num">{s.order}</span>
            <strong className="step-title">{(showTitles || s.title) && s.title}</strong>
            {s.isCritical && <span className="badge badge-red">Critical</span>}
            <span className="badge">{fmtDuration(s.plannedTimeSeconds)}</span>
          </div>
          <div className="rich" dangerouslySetInnerHTML={{ __html: s.description }} />
          {s.linkedSop && (
            <div className="muted" style={{ marginTop: 6 }}>
              See also: <a href={`/sops/${s.linkedSop.id}`}>{s.linkedSop.referenceNo} — {s.linkedSop.name}</a>
            </div>
          )}
          {!s.isTextOnly && s.media.length > 0 && (
            <div className="media-row">
              {s.media.map((m) =>
                m.type === 'image' ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <a key={m.id} href={m.url} target="_blank" rel="noreferrer">
                    <img src={m.url} alt={m.originalFilename} />
                  </a>
                ) : (
                  <a key={m.id} href={m.url} target="_blank" rel="noreferrer" className="btn btn-sm">
                    {m.originalFilename}
                  </a>
                ),
              )}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
