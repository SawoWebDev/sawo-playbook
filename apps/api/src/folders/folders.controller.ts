import { TrackActivity } from '../analytics/activity.service';
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { AuthUser } from '../common/auth-user';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { Permission } from '../common/permissions';
import { FoldersService } from './folders.service';

class CreateFolderDto {
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsOptional() @IsUUID() parentId?: string | null;
}

class UpdateFolderDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  /** null moves the folder to the root. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() parentId?: string | null;
}

@Controller('folders')
export class FoldersController {
  constructor(private readonly folders: FoldersService) {}

  @Get()
  @RequirePermission(Permission.SopView)
  list(@CurrentUser() actor: AuthUser) {
    return this.folders.list(actor);
  }

  @Post()
  @RequirePermission(Permission.FoldersEdit)
  @TrackActivity({ event: 'folder.created', entity: 'folder', id: 'result:id' })
  create(@CurrentUser() actor: AuthUser, @Body() dto: CreateFolderDto) {
    return this.folders.create(actor, dto.name, dto.parentId ?? null);
  }

  @Patch(':id')
  @RequirePermission(Permission.FoldersEdit)
  update(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateFolderDto) {
    return this.folders.update(actor, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission(Permission.FoldersEdit)
  async remove(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.folders.remove(actor, id);
  }
}
