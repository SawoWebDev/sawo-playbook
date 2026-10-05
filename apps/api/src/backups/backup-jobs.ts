import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';

export type JobKind = 'export' | 'restore';
export type JobStatus = 'running' | 'done' | 'failed';
export type JobPhase = 'preparing' | 'sops' | 'kanbans' | 'media' | 'finalizing' | 'validating' | 'restoring' | 'done';

export interface RestoreSummary {
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

export interface BackupJob {
  id: string;
  kind: JobKind;
  organizationId: string;
  startedById: string;
  startedByName: string;
  status: JobStatus;
  phase: JobPhase;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string | null;
  /** 0-100 overall progress. */
  percent: number;
  total: { sops: number; kanbans: number; media: number };
  done: { sops: number; kanbans: number; media: number };
  /** Export: bytes written to the file so far. Restore: bytes of media processed. */
  bytes: number;
  /** What is being worked on right now (SOP name / file name). */
  current: string | null;
  warnings: string[];
  error: string | null;
  /** Export result. */
  file: { name: string; sizeBytes: number; counts: { sops: number; versions: number; steps: number; kanbans: number; media: number } } | null;
  /** Restore result. */
  summary: RestoreSummary | null;
  /** Source file name for a restore. */
  sourceName: string | null;
}

const MAX_WARNINGS = 200;

export function storageRoot(): string {
  return process.env.STORAGE_DIR ?? './storage';
}
export function backupDir(organizationId: string): string {
  return join(storageRoot(), 'org', organizationId, 'backups');
}
export function backupZipPath(organizationId: string, id: string): string {
  return join(backupDir(organizationId), `${id}.zip`);
}
export function backupPartPath(organizationId: string, id: string): string {
  return join(backupDir(organizationId), `${id}.zip.part`);
}
function metaPath(organizationId: string, id: string): string {
  return join(backupDir(organizationId), `${id}.json`);
}

/** In-memory registry for live progress; finished exports are also written next to their .zip so they survive restarts. */
@Injectable()
export class BackupJobs {
  private readonly jobs = new Map<string, BackupJob>();

  create(input: { kind: JobKind; organizationId: string; startedById: string; startedByName: string; dryRun?: boolean; sourceName?: string }): BackupJob {
    const job: BackupJob = {
      id: randomUUID(),
      kind: input.kind,
      organizationId: input.organizationId,
      startedById: input.startedById,
      startedByName: input.startedByName,
      status: 'running',
      phase: input.kind === 'export' ? 'preparing' : 'validating',
      dryRun: !!input.dryRun,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      percent: 0,
      total: { sops: 0, kanbans: 0, media: 0 },
      done: { sops: 0, kanbans: 0, media: 0 },
      bytes: 0,
      current: null,
      warnings: [],
      error: null,
      file: null,
      summary: null,
      sourceName: input.sourceName ?? null,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  findRunning(organizationId: string): BackupJob | undefined {
    return [...this.jobs.values()].find((j) => j.organizationId === organizationId && j.status === 'running');
  }

  warn(job: BackupJob, message: string): void {
    if (job.warnings.length < MAX_WARNINGS) job.warnings.push(message);
    else if (job.warnings.length === MAX_WARNINGS) job.warnings.push('…further warnings omitted');
  }

  /** sops + kanbans + media + one final step count as the units of the progress bar. */
  setPercent(job: BackupJob, finalizingDone = false): void {
    const total = job.total.sops + job.total.kanbans + job.total.media + 1;
    const done = job.done.sops + job.done.kanbans + job.done.media + (finalizingDone ? 1 : 0);
    job.percent = Math.min(100, Math.floor((done / Math.max(1, total)) * 100));
  }

  async finish(job: BackupJob): Promise<void> {
    job.status = 'done';
    job.phase = 'done';
    job.percent = 100;
    job.current = null;
    job.finishedAt = new Date().toISOString();
    if (job.kind === 'export' && job.file) await this.persist(job);
    this.expireLater(job);
  }

  async fail(job: BackupJob, error: unknown): Promise<void> {
    job.status = 'failed';
    job.error = error instanceof Error ? error.message : String(error);
    job.current = null;
    job.finishedAt = new Date().toISOString();
    this.expireLater(job);
  }

  /** Restores (and failed exports) are only kept in memory, for an hour, so their result page can still be opened. */
  private expireLater(job: BackupJob): void {
    if (job.kind === 'export' && job.status === 'done') return;
    const t = setTimeout(() => this.jobs.delete(job.id), 60 * 60 * 1000);
    t.unref();
  }

  private async persist(job: BackupJob): Promise<void> {
    await mkdir(backupDir(job.organizationId), { recursive: true });
    await writeFile(metaPath(job.organizationId, job.id), JSON.stringify(job), 'utf8');
  }

  async get(organizationId: string, id: string): Promise<BackupJob | null> {
    const live = this.jobs.get(id);
    if (live) return live.organizationId === organizationId ? live : null;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    try {
      const job = JSON.parse(await readFile(metaPath(organizationId, id), 'utf8')) as BackupJob;
      return job.organizationId === organizationId ? job : null;
    } catch {
      return null;
    }
  }

  /** Running jobs plus every finished export whose .zip is still on disk, newest first. */
  async list(organizationId: string): Promise<BackupJob[]> {
    const out = new Map<string, BackupJob>();
    for (const j of this.jobs.values()) if (j.organizationId === organizationId) out.set(j.id, j);
    const dir = backupDir(organizationId);
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      /* no backups yet */
    }
    for (const name of names) {
      if (name.endsWith('.zip.part')) {
        const id = name.slice(0, -'.zip.part'.length);
        const old = Date.now() - (await stat(join(dir, name)).then((s) => s.mtimeMs, () => Date.now())) > 60_000;
        if (old && !this.jobs.has(id)) await rm(join(dir, name), { force: true });
        continue;
      }
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      if (out.has(id)) continue;
      const job = await this.get(organizationId, id);
      if (job?.file && (await stat(backupZipPath(organizationId, id)).then(() => true, () => false))) out.set(id, job);
    }
    return [...out.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async remove(organizationId: string, id: string): Promise<boolean> {
    const job = await this.get(organizationId, id);
    if (!job || job.status === 'running') return false;
    this.jobs.delete(id);
    await rm(backupZipPath(organizationId, id), { force: true });
    await rm(metaPath(organizationId, id), { force: true });
    return true;
  }
}
