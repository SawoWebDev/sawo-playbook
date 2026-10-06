'use client';

import './backups.css';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, apiUpload } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage, fmtDateTime } from '@/lib/format';
import { hasPermission } from '@/lib/permissions';

interface RestoreSummary {
  dryRun: boolean;
  sopsInFile: number;
  created: number;
  skipped: { referenceNo: string; name: string; reason: string }[];
  failed: { referenceNo: string; name: string; error: string }[];
  versions: number;
  steps: number;
  mediaCreated: number;
  foldersCreated: number;
  usersCreated: number;
  usersMatched: number;
  kanbans: { inFile: number; created: number; skipped: number; failed: { partCode: string; error: string }[] };
}

interface Job {
  id: string;
  kind: 'export' | 'restore';
  status: 'running' | 'done' | 'failed';
  phase: 'preparing' | 'sops' | 'kanbans' | 'media' | 'finalizing' | 'validating' | 'restoring' | 'done';
  dryRun: boolean;
  startedAt: string;
  finishedAt: string | null;
  startedByName: string;
  sourceName: string | null;
  percent: number;
  total: { sops: number; kanbans: number; media: number };
  done: { sops: number; kanbans: number; media: number };
  bytes: number;
  current: string | null;
  warnings: string[];
  error: string | null;
  file: { name: string; sizeBytes: number; counts: { sops: number; versions: number; steps: number; kanbans: number; media: number } } | null;
  summary: RestoreSummary | null;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

const EXPORT_STEPS = [
  { key: 'preparing', label: 'Reading organization' },
  { key: 'sops', label: 'Collecting SOPs' },
  { key: 'kanbans', label: 'Collecting kanbans' },
  { key: 'media', label: 'Packing images' },
  { key: 'finalizing', label: 'Finishing file' },
] as const;
const RESTORE_STEPS = [
  { key: 'validating', label: 'Checking the file' },
  { key: 'restoring', label: 'Restoring SOPs' },
] as const;

export default function BackupsPage() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <Backups />
    </Suspense>
  );
}

function Backups() {
  const { user } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const [jobId, setJobId] = useState<string | null>(params.get('job'));
  const [job, setJob] = useState<Job | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const attachedOnce = useRef(false);
  const isManager = hasPermission(user, 'org.settings.manage');

  const loadList = useCallback(async () => {
    try {
      setJobs(await api<Job[]>('/backups'));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  const watch = useCallback(
    (id: string | null) => {
      setJobId(id);
      setJob(null);
      router.replace(id ? `/backups?job=${id}` : '/backups', { scroll: false });
    },
    [router],
  );

  useEffect(() => {
    if (isManager) void loadList();
  }, [isManager, loadList]);

  // Coming back to the page (or opening it in a new tab) while something is running re-attaches to it.
  useEffect(() => {
    if (attachedOnce.current || jobId || !jobs.length) return;
    attachedOnce.current = true;
    const running = jobs.find((j) => j.status === 'running');
    if (running) watch(running.id);
  }, [jobs, jobId, watch]);

  // Live progress: poll the job until it finishes.
  useEffect(() => {
    if (!jobId || !isManager) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const j = await api<Job>(`/backups/${jobId}`);
        if (stopped) return;
        setJob(j);
        setError(null);
        if (j.status === 'running') timer = setTimeout(tick, 500);
        else void loadList();
      } catch (e) {
        if (stopped) return;
        if (e instanceof ApiError && e.status === 404) {
          setError('This job is no longer available. Finished restores are only kept for an hour.');
          return;
        }
        timer = setTimeout(tick, 1500); // transient problem — keep trying
      }
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId, isManager, loadList]);

  async function startBackup() {
    setBusy(true);
    setError(null);
    try {
      const j = await api<Job>('/backups', { method: 'POST' });
      watch(j.id);
      void loadList();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function download(id: string) {
    try {
      const r = await api<{ url: string }>(`/backups/${id}/download-link`, { method: 'POST' });
      const a = document.createElement('a');
      a.href = r.url;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function remove(j: Job) {
    if (!window.confirm(`Delete this backup (${j.file ? fmtBytes(j.file.sizeBytes) : ''}) from the server? This cannot be undone.`)) return;
    try {
      await api(`/backups/${j.id}`, { method: 'DELETE' });
      if (jobId === j.id) watch(null);
      void loadList();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  if (user && !isManager) {
    return (
      <>
        <h1>Backups</h1>
        <p className="muted">Only the organization owner and admins can create and restore backups.</p>
      </>
    );
  }

  const running = job?.status === 'running' || jobs.some((j) => j.status === 'running');

  return (
    <>
      <h1>Backups</h1>
      <p className="muted bk-lead">
        A backup is a single file with every SOP and kanban in this organization — all versions, steps, settings and images — ready to be restored here or into another organization.
        Keep copies somewhere safe.
      </p>

      <div className="bk-actions">
        <button className="btn btn-primary" onClick={() => void startBackup()} disabled={busy || running}>
          Create backup
        </button>
      </div>

      {error && <div className="error">{error}</div>}
      {job && <ProgressPanel job={job} onDownload={() => void download(job.id)} />}

      <RestorePanel
        disabled={running}
        onStarted={(id) => {
          watch(id);
          void loadList();
        }}
        onError={setError}
      />

      <h2>History</h2>
      {jobs.length === 0 ? (
        <p className="muted">No backups yet. Create one with the button above.</p>
      ) : (
        <table className="table bk-table">
          <thead>
            <tr>
              <th>When</th>
              <th>What</th>
              <th>By</th>
              <th className="num">SOPs</th>
              <th className="num">Kanbans</th>
              <th className="num">Images</th>
              <th className="num">Size</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(j.startedAt)}</td>
                <td>
                  {j.kind === 'export' ? 'Backup' : j.dryRun ? 'Restore check' : 'Restore'}{' '}
                  {j.status === 'running' && <span className="badge">running</span>}
                  {j.status === 'failed' && <span className="badge badge-red">failed</span>}
                </td>
                <td>{j.startedByName}</td>
                <td className="num">{j.file?.counts.sops ?? j.summary?.created ?? '—'}</td>
                <td className="num">{j.file?.counts.kanbans ?? j.summary?.kanbans?.created ?? '—'}</td>
                <td className="num">{j.file?.counts.media ?? j.summary?.mediaCreated ?? '—'}</td>
                <td className="num">{j.file ? fmtBytes(j.file.sizeBytes) : '—'}</td>
                <td>
                  <div className="bk-row-actions">
                    <button className="btn btn-sm" onClick={() => watch(j.id)}>
                      View
                    </button>
                    {j.kind === 'export' && j.file && (
                      <>
                        <button className="btn btn-sm" onClick={() => void download(j.id)}>
                          Download
                        </button>
                        <button className="btn btn-sm btn-danger" onClick={() => void remove(j)}>
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function ProgressPanel({ job, onDownload }: { job: Job; onDownload: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (job.status !== 'running') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [job.status]);

  const isExport = job.kind === 'export';
  const steps = isExport ? EXPORT_STEPS : job.dryRun ? RESTORE_STEPS.slice(0, 1) : RESTORE_STEPS;
  const current = Math.max(0, steps.findIndex((s) => s.key === job.phase));
  const elapsed = (job.finishedAt ? new Date(job.finishedAt).getTime() : now) - new Date(job.startedAt).getTime();
  const title = isExport
    ? job.status === 'running' ? 'Creating backup…' : job.status === 'done' ? 'Backup complete' : 'Backup failed'
    : job.dryRun
      ? job.status === 'running' ? 'Checking backup file…' : job.status === 'done' ? 'Backup file checked' : 'Backup file rejected'
      : job.status === 'running' ? 'Restoring…' : job.status === 'done' ? 'Restore complete' : 'Restore failed';
  const barClass = job.status === 'done' ? 'is-done' : job.status === 'failed' ? 'is-failed' : '';
  const verbs = isExport
    ? { sops: 'SOPs', kanbans: 'Kanbans', media: 'Images' }
    : job.dryRun
      ? { sops: 'SOPs checked', kanbans: 'Kanbans checked', media: 'Images checked' }
      : { sops: 'SOPs restored', kanbans: 'Kanbans restored', media: 'Images restored' };

  return (
    <section className="card bk-panel" aria-label="Progress">
      <div className="bk-head">
        <h2 role="status">{title}</h2>
        {job.status === 'running' && <span className="badge">in progress</span>}
        {job.status === 'done' && <span className="badge badge-green">done</span>}
        {job.status === 'failed' && <span className="badge badge-red">failed</span>}
      </div>
      <p className="muted bk-sub">
        Started {fmtDateTime(job.startedAt)} by {job.startedByName}
        {job.sourceName ? ` · ${job.sourceName}` : ''}
      </p>

      <div className="bk-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.percent} aria-label={title}>
        <div className={`bk-bar-fill ${barClass}`} style={{ width: `${job.percent}%` }} />
      </div>
      <div className="bk-pct">{job.percent}%</div>

      <ol className="bk-steps">
        {steps.map((s, i) => {
          const state = job.status === 'done' || i < current ? 'is-done' : i === current ? (job.status === 'failed' ? 'is-failed' : 'is-active') : '';
          return (
            <li key={s.key} className={`bk-step ${state}`}>
              <span className="bk-dot" aria-hidden>
                {state === 'is-done' ? '✓' : state === 'is-failed' ? '!' : ''}
              </span>
              {s.label}
            </li>
          );
        })}
      </ol>

      <div className="bk-tiles">
        <Tile label={verbs.sops} value={`${job.done.sops} / ${job.total.sops}`} />
        {(isExport || job.total.kanbans > 0) && <Tile label={verbs.kanbans} value={`${job.done.kanbans} / ${job.total.kanbans}`} />}
        <Tile label={verbs.media} value={`${job.done.media} / ${job.total.media}`} />
        <Tile label={isExport ? (job.status === 'running' ? 'File size so far' : 'File size') : 'Image data'} value={fmtBytes(job.bytes)} />
        <Tile label="Elapsed" value={fmtElapsed(elapsed)} />
      </div>
      <div className="bk-current" aria-live="off">
        {job.status === 'running' && job.current ? `Working on: ${job.current}` : ''}
      </div>

      {job.error && <div className="error">{job.error}</div>}

      {job.status === 'done' && job.file && (
        <div className="bk-result">
          <h3>{job.file.name}</h3>
          <p className="muted" style={{ margin: '0 0 10px' }}>
            {fmtBytes(job.file.sizeBytes)} · {job.file.counts.sops} SOPs · {job.file.counts.versions} versions · {job.file.counts.steps} steps · {job.file.counts.kanbans} kanbans · {job.file.counts.media} images
          </p>
          <button className="btn btn-primary" onClick={onDownload}>
            Download backup
          </button>
        </div>
      )}

      {job.status === 'done' && job.summary && <RestoreResult summary={job.summary} />}

      {job.warnings.length > 0 && (
        <details className="bk-warn" open={job.status !== 'running'}>
          <summary>
            {job.warnings.length} warning{job.warnings.length === 1 ? '' : 's'}
          </summary>
          <ul className="bk-list">
            {job.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="bk-tile">
      <div className="bk-tile-label">{label}</div>
      <div className="bk-tile-value">{value}</div>
    </div>
  );
}

function RestoreResult({ summary }: { summary: RestoreSummary }) {
  return (
    <div className="bk-result">
      <h3>{summary.dryRun ? 'What a restore would do' : 'Restore result'}</h3>
      <p style={{ margin: '0 0 6px' }}>
        <strong>{summary.created}</strong> {summary.dryRun ? 'SOPs would be created' : 'SOPs restored'} ({summary.versions} versions, {summary.steps} steps
        {summary.dryRun ? '' : `, ${summary.mediaCreated} images`}).
        {!summary.dryRun && (summary.foldersCreated > 0 || summary.usersCreated > 0) &&
          ` Also created ${summary.foldersCreated} folder(s) and ${summary.usersCreated} placeholder user(s) for people who were not in this organization.`}
      </p>
      {summary.kanbans.inFile > 0 && (
        <p style={{ margin: '0 0 6px' }}>
          <strong>{summary.kanbans.created}</strong> {summary.dryRun ? 'kanbans would be created' : 'kanbans restored'}
          {summary.kanbans.skipped > 0 && ` · ${summary.kanbans.skipped} already exist and were skipped`}
          {summary.kanbans.failed.length > 0 && ` · ${summary.kanbans.failed.length} could not be restored`}.
        </p>
      )}
      {summary.kanbans.failed.length > 0 && (
        <details className="bk-warn" open>
          <summary className="error">{summary.kanbans.failed.length} kanban(s) could not be restored</summary>
          <ul className="bk-list">
            {summary.kanbans.failed.map((k, i) => (
              <li key={i}>
                {k.partCode}: {k.error}
              </li>
            ))}
          </ul>
        </details>
      )}
      {summary.skipped.length > 0 && (
        <details className="bk-warn">
          <summary>{summary.skipped.length} skipped</summary>
          <ul className="bk-list">
            {summary.skipped.map((s, i) => (
              <li key={i}>
                {s.referenceNo} — {s.name}: {s.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      {summary.failed.length > 0 && (
        <details className="bk-warn" open>
          <summary className="error">{summary.failed.length} could not be restored</summary>
          <ul className="bk-list">
            {summary.failed.map((s, i) => (
              <li key={i}>
                {s.referenceNo} — {s.name}: {s.error}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function RestorePanel({ disabled, onStarted, onError }: { disabled: boolean; onStarted: (jobId: string) => void; onError: (m: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function submit(e: FormEvent, dryRun: boolean) {
    e.preventDefault();
    if (!file) return;
    if (!dryRun && !window.confirm('Restore the SOPs in this file into this organization? SOPs that already exist (same reference number) are skipped — nothing is overwritten.')) return;
    const form = new FormData();
    form.append('file', file);
    setUploadPct(0);
    try {
      const job = await apiUpload<Job>(`/backups/restore${dryRun ? '?dryRun=true' : ''}`, form, (l, t) => setUploadPct(Math.round((l / t) * 100)));
      onStarted(job.id);
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setUploadPct(null);
    }
  }

  return (
    <section className="card bk-restore" aria-label="Restore from a backup file">
      <h2 style={{ marginTop: 0 }}>Restore from a backup file</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Choose a backup file made by this app. “Check file” reads it end to end (checksums, formats, images) and shows what would happen without changing anything.
        Restoring never overwrites a SOP that already exists.
      </p>
      <form className="bk-restore-row" onSubmit={(e) => void submit(e, false)}>
        <input ref={input} type="file" accept=".zip,application/zip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label="Backup file" />
        <button type="button" className="btn" disabled={!file || disabled || uploadPct !== null} onClick={(e) => void submit(e, true)}>
          Check file
        </button>
        <button type="submit" className="btn btn-primary" disabled={!file || disabled || uploadPct !== null}>
          Restore
        </button>
      </form>
      {file && <p className="muted" style={{ margin: '8px 0 0', fontSize: 13 }}>{file.name} · {fmtBytes(file.size)}</p>}
      {uploadPct !== null && (
        <div className="bk-upload" aria-live="polite">
          <div className="bk-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={uploadPct} aria-label="Uploading">
            <div className="bk-bar-fill" style={{ width: `${uploadPct}%` }} />
          </div>
          <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>Uploading… {uploadPct}%</div>
        </div>
      )}
    </section>
  );
}
