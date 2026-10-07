'use client';

import { Loading } from '@/components/feedback/Loading';
import { useToast } from '@/components/feedback/Toast';
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
  extra?: {
    groups: { inFile: number; created: number; memberships: number };
    settingsApplied: boolean;
    passwordAccounts: number;
    invitationsInFile: number;
    revisions: { inFile: number; created: number; skipped: number };
    checklists: { inFile: number; created: number; skipped: number };
    training: { trainers: number; assessments: number; records: number; skipped: number };
    activity: { inFile: number; created: number };
  };
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
  /** Export: what this backup includes. */
  sections: BackupSection[];
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

type BackupSection = 'sops' | 'kanbans' | 'people' | 'settings' | 'training' | 'checklists' | 'activity';

/** Every section, in display order. A backup with all of them is the full backup and is the default. */
const ALL_SECTIONS: BackupSection[] = ['sops', 'kanbans', 'people', 'settings', 'training', 'checklists', 'activity'];

const SECTION_LABEL: Record<BackupSection, string> = {
  sops: 'SOPs & folders',
  kanbans: 'Kanbans',
  people: 'People & groups',
  settings: 'Settings & roles',
  training: 'Training & skills',
  checklists: 'Checklists',
  activity: 'Activity log',
};

const SECTION_HINT: Record<BackupSection, string> = {
  sops: 'Every SOP, version, step, approval and image',
  kanbans: 'Every kanban card and its open change proposals',
  people: 'All accounts with role, status and special access, plus groups and pending invitations',
  settings: 'Approval rules, role permissions and the sidebar menu',
  training: 'Trainer assignments, skill assessments and current skill levels',
  checklists: 'Checklist submissions and their answers',
  activity: 'Activity events (the audit trail is not included)',
};

/** Short description of what a backup holds, for the list. */
function coverage(sections: BackupSection[]): string {
  if (sections.length === ALL_SECTIONS.length) return 'Full backup';
  return sections.map((s) => SECTION_LABEL[s]).join(', ');
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
    <Suspense fallback={<Loading />}>
      <Backups />
    </Suspense>
  );
}

function Backups() {
  const { user } = useAuth();
  const toast = useToast();
  const router = useRouter();
  const params = useSearchParams();
  const [jobId, setJobId] = useState<string | null>(params.get('job'));
  const [job, setJob] = useState<Job | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobsLoaded, setJobsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sections, setSections] = useState<BackupSection[]>(ALL_SECTIONS);
  const [includePasswords, setIncludePasswords] = useState(false);
  const attachedOnce = useRef(false);
  const isManager = hasPermission(user, 'org.settings.manage');

  const loadList = useCallback(async () => {
    try {
      setJobs(await api<Job[]>('/backups'));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setJobsLoaded(true);
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
    // Announce the end of a job only if this page watched it running, not when reopening an old one.
    let sawRunning = false;
    const tick = async () => {
      try {
        const j = await api<Job>(`/backups/${jobId}`);
        if (stopped) return;
        setJob(j);
        setError(null);
        if (j.status === 'running') {
          sawRunning = true;
          timer = setTimeout(tick, 500);
        } else {
          void loadList();
          if (sawRunning) {
            const what = j.kind === 'export' ? 'Backup' : j.dryRun ? 'Backup file check' : 'Restore';
            if (j.status === 'done') toast.success(`${what} finished.`);
            else toast.error(`${what} failed.${j.error ? ` ${j.error}` : ''}`);
          }
        }
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
  }, [jobId, isManager, loadList, toast]);

  async function startBackup() {
    setBusy(true);
    setError(null);
    try {
      const withPasswords = includePasswords && sections.includes('people');
      const j = await api<Job>('/backups', { method: 'POST', body: { sections, includePasswords: withPasswords } });
      toast.info(sections.length === ALL_SECTIONS.length ? 'Full backup started. You can follow its progress below.' : `Backup started (${coverage(sections)}). You can follow its progress below.`);
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
      toast.success('Download started.');
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function remove(j: Job) {
    if (!window.confirm(`Delete this backup (${j.file ? fmtBytes(j.file.sizeBytes) : ''}) from the server? This cannot be undone.`)) return;
    try {
      await api(`/backups/${j.id}`, { method: 'DELETE' });
      toast.success('Backup deleted.');
      if (jobId === j.id) watch(null);
      void loadList();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  if (user && !isManager) {
    return (
      <>
        <div className="um-card"><div className="um-empty"><i className="fa-solid fa-lock" aria-hidden /><p>Only the organization owner and admins can create and restore backups.</p></div></div>
      </>
    );
  }

  const running = job?.status === 'running' || jobs.some((j) => j.status === 'running');
  const exports = jobs.filter((j) => j.kind === 'export' && j.status === 'done' && j.file);
  const latest = exports[0] ?? null;
  const restores = jobs.filter((j) => j.kind === 'restore' && !j.dryRun).length;

  return (
    <>
      <div className="page-head">
        <p className="page-lead">
          A backup is one file with everything in this Playbook. Everything is included by default; switch off what you do not need. Keep copies somewhere safe.
        </p>
        <div className="page-head-actions">
          <button className="btn btn-primary" onClick={() => void startBackup()} disabled={busy || running}>
            <i className="fa-solid fa-cloud-arrow-down" aria-hidden /> {running ? 'Working…' : sections.length === ALL_SECTIONS.length ? 'Create full backup' : 'Create backup'}
          </button>
        </div>
      </div>

      <section className="card" aria-label="What to include" style={{ marginBottom: 16 }}>
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0 }}>What to include</h3>
          {sections.length === ALL_SECTIONS.length ? <span className="badge badge-green">Full backup</span> : <span className="badge badge-amber">Partial backup: {coverage(sections)}</span>}
        </div>
        <div className="um-role-chips" role="group" aria-label="Sections to include" style={{ marginTop: 12 }}>
          {ALL_SECTIONS.map((s) => {
            const on = sections.includes(s);
            return (
              <button
                key={s}
                type="button"
                className={`um-role-chip${on ? ' is-on' : ''}`}
                aria-pressed={on}
                title={SECTION_HINT[s]}
                disabled={busy || running || (on && sections.length === 1)}
                onClick={() => setSections((x) => (on ? x.filter((v) => v !== s) : ALL_SECTIONS.filter((v) => v === s || x.includes(v))))}
              >
                {SECTION_LABEL[s]}
              </button>
            );
          })}
        </div>
        {sections.includes('people') && (
          <label className="row" style={{ marginTop: 12, fontWeight: 400, alignItems: 'flex-start' }}>
            <input type="checkbox" style={{ width: 'auto', marginTop: 3 }} checked={includePasswords} disabled={busy || running} onChange={(e) => setIncludePasswords(e.target.checked)} />
            <span style={{ fontSize: 13 }}>
              Include sign-in passwords, for the one-time transfer only. The file then holds password hashes: keep it private and delete it after the import.
            </span>
          </label>
        )}
        <p className="muted" style={{ fontSize: 12, marginBottom: 0, marginTop: 10 }}>
          Two-factor secrets, sign-in sessions and reset tokens are never included. A restore brings everything in the file back; people who already have an account here keep theirs.
        </p>
        {sections.length !== ALL_SECTIONS.length && (
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
            <button className="btn btn-sm" type="button" disabled={busy || running} onClick={() => setSections(ALL_SECTIONS)}>Select everything</button>
          </div>
        )}
      </section>

      <div className="kpi-grid">
        <div className="kpi">
          <span className="kpi-icon"><i className="fa-solid fa-box-archive" aria-hidden /></span>
          <span className="kpi-text"><span className="kpi-value">{exports.length}</span><span className="kpi-label">Backups on the server</span></span>
        </div>
        <div className={`kpi${latest ? ' kpi-good' : ' kpi-warn'}`}>
          <span className="kpi-icon"><i className="fa-solid fa-clock" aria-hidden /></span>
          <span className="kpi-text">
            <span className="kpi-value" style={{ fontSize: 15 }}>{latest ? fmtDateTime(latest.startedAt) : 'Never'}</span>
            <span className="kpi-label">Latest backup</span>
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-icon"><i className="fa-solid fa-weight-hanging" aria-hidden /></span>
          <span className="kpi-text"><span className="kpi-value">{latest?.file ? fmtBytes(latest.file.sizeBytes) : '—'}</span><span className="kpi-label">Latest size</span></span>
        </div>
        <div className="kpi">
          <span className="kpi-icon"><i className="fa-solid fa-clock-rotate-left" aria-hidden /></span>
          <span className="kpi-text"><span className="kpi-value">{restores}</span><span className="kpi-label">Restores run</span></span>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {job && <ProgressPanel job={job} onDownload={() => void download(job.id)} />}

      <RestorePanel
        disabled={running}
        onStarted={(id, dryRun) => {
          toast.info(dryRun ? 'Checking the backup file…' : 'Restore started. You can follow its progress below.');
          watch(id);
          void loadList();
        }}
        onError={setError}
      />

      <section className="ui-section">
        <div className="ui-section-head">
          <h3>History</h3>
        </div>
        <div className="um-card">
          {!jobsLoaded ? (
            <Loading label="Loading backup history…" />
          ) : jobs.length === 0 ? (
            <div className="um-empty">
              <i className="fa-solid fa-box-archive" aria-hidden />
              <p>No backups yet. Create one with the button above.</p>
            </div>
          ) : (
            <div className="um-table-wrap">
              <table className="um-table bk-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>What</th>
                    <th>By</th>
                    <th className="num">SOPs</th>
                    <th className="num">Kanbans</th>
                    <th className="num">Images</th>
                    <th className="num">Size</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((j) => (
                    <tr key={j.id} className={jobId === j.id ? 'is-current' : ''}>
                      <td className="um-nowrap muted">{fmtDateTime(j.startedAt)}</td>
                      <td>
                        <span className="bk-kind">
                          <i className={`fa-solid ${j.kind === 'export' ? 'fa-box-archive' : j.dryRun ? 'fa-magnifying-glass' : 'fa-clock-rotate-left'}`} aria-hidden />
                          {j.kind === 'export' ? 'Backup' : j.dryRun ? 'Restore check' : 'Restore'}
                        </span>{' '}
                        {j.kind === 'export' && j.sections?.length > 0 && <span className="muted" style={{ fontSize: 12 }}>{coverage(j.sections)}</span>}{' '}
                        {j.status === 'running' && <span className="badge badge-amber">running</span>}
                        {j.status === 'failed' && <span className="badge badge-red">failed</span>}
                      </td>
                      <td>{j.startedByName}</td>
                      <td className="num">{j.file?.counts.sops ?? j.summary?.created ?? '—'}</td>
                      <td className="num">{j.file?.counts.kanbans ?? j.summary?.kanbans?.created ?? '—'}</td>
                      <td className="num">{j.file?.counts.media ?? j.summary?.mediaCreated ?? '—'}</td>
                      <td className="num">{j.file ? fmtBytes(j.file.sizeBytes) : '—'}</td>
                      <td>
                        <div className="bk-row-actions">
                          <button className="grp-icon-btn" title="View details" aria-label="View details" onClick={() => watch(j.id)}>
                            <i className="fa-solid fa-eye" aria-hidden />
                          </button>
                          {j.kind === 'export' && j.file && (
                            <>
                              <button className="grp-icon-btn" title="Download" aria-label="Download" onClick={() => void download(j.id)}>
                                <i className="fa-solid fa-download" aria-hidden />
                              </button>
                              <button className="grp-icon-btn danger" title="Delete" aria-label="Delete" onClick={() => void remove(j)}>
                                <i className="fa-solid fa-trash" aria-hidden />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
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
      {summary.extra && (
        <ul className="bk-extra" style={{ margin: '0 0 6px', paddingLeft: 18 }}>
          {summary.extra.groups.inFile > 0 && (
            <li>
              <strong>{summary.dryRun ? summary.extra.groups.inFile : summary.extra.groups.created}</strong> {summary.dryRun ? 'groups in the file' : 'groups restored'}, with {summary.extra.groups.memberships} memberships.
            </li>
          )}
          {(summary.dryRun ? true : summary.extra.settingsApplied) && <li>{summary.dryRun ? 'Organization settings in the file.' : 'Organization settings applied: approval rules, role permissions and menu layout.'}</li>}
          {summary.extra.passwordAccounts > 0 && (
            <li>
              <strong>{summary.extra.passwordAccounts}</strong> {summary.dryRun ? 'accounts carry' : 'accounts restored with'} their sign-in password.
            </li>
          )}
          {summary.extra.revisions.inFile > 0 && (
            <li>
              <strong>{summary.dryRun ? summary.extra.revisions.inFile : summary.extra.revisions.created}</strong> kanban proposals {summary.dryRun ? 'in the file' : 'restored'}
              {!summary.dryRun && summary.extra.revisions.skipped > 0 ? `, ${summary.extra.revisions.skipped} skipped` : ''}.
            </li>
          )}
          {summary.extra.checklists.inFile > 0 && (
            <li>
              <strong>{summary.dryRun ? summary.extra.checklists.inFile : summary.extra.checklists.created}</strong> checklist submissions {summary.dryRun ? 'in the file' : 'restored'}
              {!summary.dryRun && summary.extra.checklists.skipped > 0 ? `, ${summary.extra.checklists.skipped} skipped` : ''}.
            </li>
          )}
          {(summary.extra.training.trainers + summary.extra.training.assessments + summary.extra.training.records) > 0 && (
            <li>
              Training: {summary.extra.training.trainers} trainers, {summary.extra.training.assessments} assessments, {summary.extra.training.records} skill records
              {summary.dryRun ? ' in the file' : ' restored'}.
            </li>
          )}
          {summary.extra.activity.inFile > 0 && (
            <li>
              <strong>{summary.dryRun ? summary.extra.activity.inFile : summary.extra.activity.created}</strong> activity events {summary.dryRun ? 'in the file' : 'restored'}.
            </li>
          )}
          {summary.extra.invitationsInFile > 0 && (
            <li className="muted">
              {summary.extra.invitationsInFile} pending invitations in the file are not restored: their links cannot be carried over, so send them again.
            </li>
          )}
        </ul>
      )}
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

function RestorePanel({ disabled, onStarted, onError }: { disabled: boolean; onStarted: (jobId: string, dryRun: boolean) => void; onError: (m: string) => void }) {
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
      onStarted(job.id, dryRun);
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setUploadPct(null);
    }
  }

  return (
    <section className="card bk-restore" aria-label="Restore from a backup file">
      <div className="pf-card-head">
        <span className="kpi-icon"><i className="fa-solid fa-clock-rotate-left" aria-hidden /></span>
        <div>
          <h3>Restore from a backup file</h3>
          <p className="muted">
            “Check file” reads it end to end (checksums, formats, images) and shows what would happen without changing anything. Restoring never overwrites a SOP that already exists.
          </p>
        </div>
      </div>
      <form className="bk-restore-row" onSubmit={(e) => void submit(e, false)}>
        <label className={`bk-drop${file ? ' has-file' : ''}`}>
          <input ref={input} type="file" accept=".zip,application/zip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label="Backup file" />
          <i className={`fa-solid ${file ? 'fa-file-zipper' : 'fa-upload'}`} aria-hidden />
          <span className="bk-drop-text">
            {file ? (
              <>
                <b>{file.name}</b>
                <span className="muted">{fmtBytes(file.size)} · click to choose another file</span>
              </>
            ) : (
              <>
                <b>Choose a backup file</b>
                <span className="muted">A .zip made by this app</span>
              </>
            )}
          </span>
        </label>
        <div className="bk-restore-actions">
          <button type="button" className="btn" disabled={!file || disabled || uploadPct !== null} onClick={(e) => void submit(e, true)}>
            <i className="fa-solid fa-magnifying-glass" aria-hidden /> Check file
          </button>
          <button type="submit" className="btn btn-primary" disabled={!file || disabled || uploadPct !== null}>
            <i className="fa-solid fa-clock-rotate-left" aria-hidden /> Restore
          </button>
        </div>
      </form>
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
