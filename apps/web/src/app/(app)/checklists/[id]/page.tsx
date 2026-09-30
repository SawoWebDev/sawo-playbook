'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, apiRaw } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage, fmtDateTime, fmtDuration } from '@/lib/format';
import type { MediaItem, VersionDetail } from '@/lib/types';

type Result = 'ok' | 'not_ok' | 'n_a';

interface ChecklistDetail {
  id: string;
  status: 'in_progress' | 'completed' | 'abandoned';
  startedAt: string;
  completedAt: string | null;
  operator: { id: string; name: string } | null;
  sop: { id: string; name: string; referenceNo: string };
  version: VersionDetail;
  responses: { stepId: string; result: Result | null; value: string | null; comment: string | null; recordedAt: string; media: MediaItem | null }[];
}

const RESULT_LABEL: Record<Result, string> = { ok: 'OK', not_ok: 'NOT OK', n_a: 'N/A' };
const RESULT_CLS: Record<Result, string> = { ok: 'badge-green', not_ok: 'badge-red', n_a: '' };

export default function ChecklistRunPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const [data, setData] = useState<ChecklistDetail | null>(null);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api<ChecklistDetail>(`/checklists/${id}`);
      setData(d);
      setComments(Object.fromEntries(d.responses.map((r) => [r.stepId, r.comment ?? ''])));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !data) return <div className="error">{error}</div>;
  if (!data) return <p className="muted">Loading…</p>;

  const editable = data.status === 'in_progress' && data.operator?.id === user?.id;
  const byStep = new Map(data.responses.map((r) => [r.stepId, r]));
  const answered = data.responses.filter((r) => r.result).length;

  async function respond(stepId: string, patch: { result?: Result | null; mediaAssetId?: string | null }) {
    const current = byStep.get(stepId);
    setBusy(true);
    setError(null);
    try {
      const d = await api<ChecklistDetail>(`/checklists/${id}/responses/${stepId}`, {
        method: 'PUT',
        body: {
          result: patch.result !== undefined ? patch.result : current?.result ?? null,
          comment: comments[stepId] ?? current?.comment ?? null,
          mediaAssetId: patch.mediaAssetId !== undefined ? patch.mediaAssetId : current?.media?.id ?? null,
        },
      });
      setData(d);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function uploadPhoto(stepId: string, file: File | undefined) {
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    const res = await apiRaw(`/checklists/${id}/media`, { method: 'POST', rawBody: form });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return setError(body.message ?? 'Upload failed');
    await respond(stepId, { mediaAssetId: body.id });
  }

  async function finish(action: 'complete' | 'abandon') {
    setBusy(true);
    setError(null);
    try {
      setData(await api<ChecklistDetail>(`/checklists/${id}/${action}`, { method: 'POST' }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="row" style={{ marginBottom: 4 }}>
        <Link href="/checklists" className="muted">
          ← Checklists
        </Link>
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        <div>
          <div className="muted" style={{ fontSize: 12 }}>
            {data.sop.referenceNo} · version {data.version.label} · {data.operator?.name} · started {fmtDateTime(data.startedAt)}
          </div>
          <h1 style={{ margin: 0 }}>{data.sop.name}</h1>
        </div>
        <div className="spacer" />
        <span className="badge">
          {answered}/{data.version.steps.length} answered
        </span>
        <span className={`badge ${data.status === 'completed' ? 'badge-green' : data.status === 'in_progress' ? 'badge-amber' : ''}`}>
          {data.status.replace('_', ' ')}
        </span>
      </div>
      {error && <div className="error">{error}</div>}

      <ol className="steps">
        {data.version.steps.map((s) => {
          const r = byStep.get(s.id);
          return (
            <li key={s.id} className={`step-card${s.isCritical ? ' critical' : ''}`}>
              <div className="step-head">
                <span className="step-num">{s.order}</span>
                <strong className="step-title">{s.title}</strong>
                {s.isCritical && <span className="badge badge-red">Critical</span>}
                <span className="badge">{fmtDuration(s.plannedTimeSeconds)}</span>
                {r?.result && <span className={`badge ${RESULT_CLS[r.result]}`}>{RESULT_LABEL[r.result]}</span>}
              </div>
              <div className="rich" dangerouslySetInnerHTML={{ __html: s.description }} />
              {editable ? (
                <div className="panel" style={{ marginTop: 10 }}>
                  <div className="row">
                    {(['ok', 'not_ok', 'n_a'] as Result[]).map((res) => (
                      <button
                        key={res}
                        className={`btn btn-sm ${r?.result === res ? (res === 'not_ok' ? 'btn-danger' : 'btn-primary') : ''}`}
                        disabled={busy}
                        onClick={() => respond(s.id, { result: res })}
                      >
                        {RESULT_LABEL[res]}
                      </button>
                    ))}
                    <label className="btn btn-sm" style={{ margin: 0 }}>
                      📷 Photo
                      <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => void uploadPhoto(s.id, e.target.files?.[0])} />
                    </label>
                  </div>
                  <input
                    placeholder="Comment"
                    value={comments[s.id] ?? ''}
                    onChange={(e) => setComments({ ...comments, [s.id]: e.target.value })}
                    onBlur={() => r && (comments[s.id] ?? '') !== (r.comment ?? '') && respond(s.id, {})}
                  />
                </div>
              ) : (
                r?.comment && <p className="muted">“{r.comment}”</p>
              )}
              {r?.media && (
                <div className="media-row">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={r.media.url} alt="evidence" />
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {editable && (
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn btn-primary" disabled={busy || answered < data.version.steps.length} onClick={() => finish('complete')}>
            Complete checklist
          </button>
          <button
            className="btn btn-danger"
            disabled={busy}
            onClick={() => {
              if (confirm('Abandon this checklist?')) void finish('abandon');
            }}
          >
            Abandon
          </button>
        </div>
      )}
    </>
  );
}
