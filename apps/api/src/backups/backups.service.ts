import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { stat } from 'fs/promises';
import { AuthUser } from '../common/auth-user';
import { BackupSection, BACKUP_SECTIONS } from './backup-format';
import { BackupExporter } from './backup-export.service';
import { BackupJob, BackupJobs, backupZipPath } from './backup-jobs';
import { BackupRestorer } from './backup-restore.service';

export type BackupJobView = Omit<BackupJob, 'organizationId'>;

const DOWNLOAD_TTL_SECONDS = 10 * 60;

function view(job: BackupJob): BackupJobView {
  const { organizationId: _org, ...rest } = job;
  return rest;
}

@Injectable()
export class BackupsService {
  constructor(
    private readonly jobs: BackupJobs,
    private readonly exporter: BackupExporter,
    private readonly restorer: BackupRestorer,
  ) {}

  /**
   * Starts a backup in the background with the chosen sections (all of them when none are given). If one is already
   * running for this organization, that one is returned instead.
   */
  startExport(actor: AuthUser, requested?: BackupSection[], includePasswords = false): BackupJobView {
    if (requested?.length === 0) throw new BadRequestException('Choose at least one part to back up');
    const sections = requested?.length ? [...new Set(requested)] : [...BACKUP_SECTIONS];
    if (includePasswords && !sections.includes('people')) throw new BadRequestException('Passwords can only be included with the People section');
    const running = this.jobs.findRunning(actor.organizationId);
    if (running) {
      if (running.kind === 'export') return view(running);
      throw new ConflictException('A restore is running — wait for it to finish before starting a backup');
    }
    const job = this.jobs.create({ kind: 'export', organizationId: actor.organizationId, startedById: actor.id, startedByName: actor.name, sections, includePasswords });
    void this.exporter.run(job, actor);
    return view(job);
  }

  /** Starts a restore (or, with dryRun, only a check of the file) from an uploaded backup already saved at `path`. */
  startRestore(actor: AuthUser, file: { path: string; originalname: string }, dryRun: boolean): BackupJobView {
    const running = this.jobs.findRunning(actor.organizationId);
    if (running) throw new ConflictException('A backup or restore is already running for this organization');
    const job = this.jobs.create({ kind: 'restore', organizationId: actor.organizationId, startedById: actor.id, startedByName: actor.name, dryRun, sourceName: file.originalname.slice(0, 200) });
    void this.restorer.run(job, actor, file.path);
    return view(job);
  }

  async list(actor: AuthUser): Promise<BackupJobView[]> {
    return (await this.jobs.list(actor.organizationId)).map(view);
  }

  async get(actor: AuthUser, id: string): Promise<BackupJobView> {
    const job = await this.jobs.get(actor.organizationId, id);
    if (!job) throw new NotFoundException('Backup not found');
    return view(job);
  }

  async remove(actor: AuthUser, id: string): Promise<void> {
    const job = await this.jobs.get(actor.organizationId, id);
    if (!job) throw new NotFoundException('Backup not found');
    if (job.status === 'running') throw new ConflictException('This job is still running');
    await this.jobs.remove(actor.organizationId, id);
  }

  // ── download: a short-lived signed link, because a browser download can't carry the bearer token ──

  private sign(payload: string, exp: number): string {
    return createHmac('sha256', process.env.JWT_ACCESS_SECRET ?? '').update(`backup-download\n${payload}\n${exp}`).digest('base64url');
  }

  async createDownloadUrl(actor: AuthUser, id: string): Promise<{ url: string; expiresInSeconds: number }> {
    const job = await this.jobs.get(actor.organizationId, id);
    if (!job?.file || job.status !== 'done') throw new NotFoundException('This backup has no file to download');
    const payload = Buffer.from(`${actor.organizationId}:${id}`).toString('base64url');
    const exp = Math.floor(Date.now() / 1000) + DOWNLOAD_TTL_SECONDS;
    return { url: `/api/backups/download/${payload}?exp=${exp}&sig=${this.sign(payload, exp)}`, expiresInSeconds: DOWNLOAD_TTL_SECONDS };
  }

  /** Verifies a signed link and returns the file to stream. */
  async resolveDownload(token: string, exp: string, sig: string): Promise<{ path: string; name: string; size: number }> {
    const expNum = Number(exp);
    const expected = Buffer.from(this.sign(token, expNum));
    const given = Buffer.from(sig);
    if (!Number.isFinite(expNum) || expNum < Date.now() / 1000 || expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new NotFoundException();
    }
    const [orgId, id] = Buffer.from(token, 'base64url').toString().split(':');
    if (!orgId || !id) throw new BadRequestException();
    const job = await this.jobs.get(orgId, id);
    if (!job?.file) throw new NotFoundException();
    const path = backupZipPath(orgId, id);
    const size = await stat(path).then((s) => s.size, () => -1);
    if (size < 0) throw new NotFoundException();
    return { path, name: job.file.name, size };
  }
}
