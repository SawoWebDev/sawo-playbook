import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res, StreamableFile, UploadedFile, UseInterceptors, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SkipThrottle } from '@nestjs/throttler';
import { randomUUID } from 'crypto';
import type { Response } from 'express';
import { createReadStream } from 'fs';
import { diskStorage } from 'multer';
import { tmpdir } from 'os';
import { join } from 'path';
import { AuthUser } from '../common/auth-user';
import { CurrentUser, Public, RequirePermission } from '../common/decorators';
import { Permission } from '../common/permissions';
import { BackupsService } from './backups.service';

const MAX_RESTORE_BYTES = Number(process.env.BACKUP_MAX_UPLOAD_MB ?? 4096) * 1024 * 1024;

/** Full-organization SOP backups (one .zip with every SOP, version, step and image) and restores from such a file. Managers only. */
@Controller('backups')
export class BackupsController {
  constructor(private readonly backups: BackupsService) {}

  @Get()
  @RequirePermission(Permission.OrgSettingsManage)
  list(@CurrentUser() actor: AuthUser) {
    return this.backups.list(actor);
  }

  @Post()
  @HttpCode(202)
  @RequirePermission(Permission.OrgSettingsManage)
  start(@CurrentUser() actor: AuthUser) {
    return this.backups.startExport(actor);
  }

  @Post('restore')
  @HttpCode(202)
  @RequirePermission(Permission.OrgSettingsManage)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({ destination: tmpdir(), filename: (_req, _file, cb) => cb(null, join(`sawo-playbook-restore-${randomUUID()}.zip`)) }),
      limits: { fileSize: MAX_RESTORE_BYTES, files: 1 },
    }),
  )
  restore(@CurrentUser() actor: AuthUser, @UploadedFile() file: { path: string; originalname: string } | undefined, @Query('dryRun') dryRun?: string) {
    if (!file?.path) throw new BadRequestException('Choose a backup file to upload');
    return this.backups.startRestore(actor, file, dryRun === 'true');
  }

  /** Signed, short-lived link (no bearer token needed) — streams the file from disk. */
  @Public()
  @SkipThrottle()
  @Get('download/:token')
  async download(@Param('token') token: string, @Query('exp') exp = '', @Query('sig') sig = '', @Res({ passthrough: true }) res: Response) {
    const file = await this.backups.resolveDownload(token, exp, sig);
    res.set({
      'Content-Type': 'application/zip',
      'Content-Length': String(file.size),
      'Content-Disposition': `attachment; filename="${file.name.replace(/["\\\r\n]/g, '_')}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    return new StreamableFile(createReadStream(file.path));
  }

  /** Polled by the progress page, so it is exempt from the per-IP request limit. */
  @SkipThrottle()
  @Get(':id')
  @RequirePermission(Permission.OrgSettingsManage)
  get(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.backups.get(actor, id);
  }

  @Post(':id/download-link')
  @HttpCode(200)
  @RequirePermission(Permission.OrgSettingsManage)
  downloadLink(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.backups.createDownloadUrl(actor, id);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission(Permission.OrgSettingsManage)
  async remove(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.backups.remove(actor, id);
  }
}
