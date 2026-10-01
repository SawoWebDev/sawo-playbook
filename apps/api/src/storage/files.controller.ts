import { Controller, Get, NotFoundException, Param, Query, Res, StreamableFile } from '@nestjs/common';
import { Response } from 'express';
import { Public } from '../common/decorators';
import { sniffMime } from '../media/file-sniff';
import { StorageService } from './storage.service';

/** Serves stored files for signed URLs issued by `StorageService.signedUrl`. */
@Controller('files')
export class FilesController {
  constructor(private readonly storage: StorageService) {}

  @Public()
  @Get(':token')
  async get(
    @Param('token') token: string,
    @Query('exp') exp = '',
    @Query('sig') sig = '',
    @Query('name') name = '',
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = this.storage.verify(token, exp, sig, name);
    if (!key) throw new NotFoundException();
    const bytes = await this.storage.get(key).catch(() => null);
    if (!bytes) throw new NotFoundException();
    res.set({
      'Content-Type': sniffMime(bytes) ?? 'application/octet-stream',
      'Content-Disposition': name ? `attachment; filename="${name.replace(/["\\r\n]/g, '_')}"` : 'inline',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=300',
    });
    return new StreamableFile(bytes);
  }
}
