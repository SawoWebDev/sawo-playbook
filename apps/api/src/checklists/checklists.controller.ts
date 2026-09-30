import { TrackActivity } from '../analytics/activity.service';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ChecklistResult } from '@prisma/client';
import { IsEnum, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { memoryStorage } from 'multer';
import { AuthUser } from '../common/auth-user';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { Permission } from '../common/permissions';
import { MAX_UPLOAD_BYTES } from '../media/file-sniff';
import { UploadedFileLike } from '../media/media.service';
import { ChecklistsService } from './checklists.service';

class StartDto {
  @IsUUID() sopId!: string;
}

class ListQuery {
  @IsOptional() @IsUUID() sopId?: string;
  @IsOptional() @IsIn(['in_progress', 'completed', 'abandoned']) status?: string;
}

class ResponseDto {
  @IsOptional() @IsEnum(ChecklistResult) result?: ChecklistResult | null;
  @IsOptional() @IsString() @MaxLength(2000) value?: string | null;
  @IsOptional() @IsString() @MaxLength(4000) comment?: string | null;
  @IsOptional() @IsUUID() mediaAssetId?: string | null;
}

@Controller('checklists')
export class ChecklistsController {
  constructor(private readonly checklists: ChecklistsService) {}

  @Post()
  @RequirePermission(Permission.ChecklistComplete)
  @TrackActivity({ event: 'checklist.started', entity: 'checklist', id: 'result:id' })
  start(@CurrentUser() actor: AuthUser, @Body() dto: StartDto) {
    return this.checklists.start(actor, dto.sopId);
  }

  @Get()
  @RequirePermission(Permission.ChecklistComplete)
  list(@CurrentUser() actor: AuthUser, @Query() q: ListQuery) {
    return this.checklists.list(actor, q);
  }

  @Get(':id')
  @RequirePermission(Permission.ChecklistComplete)
  get(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.checklists.get(actor, id);
  }

  @Put(':id/responses/:stepId')
  @RequirePermission(Permission.ChecklistComplete)
  respond(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stepId', ParseUUIDPipe) stepId: string,
    @Body() dto: ResponseDto,
  ) {
    return this.checklists.respond(actor, id, stepId, dto);
  }

  @Post(':id/media')
  @RequirePermission(Permission.ChecklistComplete)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  upload(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: UploadedFileLike) {
    return this.checklists.uploadEvidence(actor, id, file);
  }

  @Post(':id/complete')
  @HttpCode(200)
  @RequirePermission(Permission.ChecklistComplete)
  @TrackActivity({ event: 'checklist.completed', entity: 'checklist', id: 'param:id' })
  complete(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.checklists.complete(actor, id);
  }

  @Post(':id/abandon')
  @HttpCode(200)
  @RequirePermission(Permission.ChecklistComplete)
  abandon(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.checklists.abandon(actor, id);
  }
}
