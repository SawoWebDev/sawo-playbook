import { Controller, Get, Param, ParseUUIDPipe, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { AuthUser } from '../common/auth-user';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { Permission } from '../common/permissions';
import { MAX_UPLOAD_BYTES } from './file-sniff';
import { MediaService, UploadedFileLike } from './media.service';

@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post()
  @RequirePermission(Permission.SopEdit)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  upload(@CurrentUser() actor: AuthUser, @UploadedFile() file: UploadedFileLike) {
    return this.media.upload(actor, file);
  }

  @Get(':id')
  @RequirePermission(Permission.SopView)
  get(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.media.get(actor, id);
  }
}
