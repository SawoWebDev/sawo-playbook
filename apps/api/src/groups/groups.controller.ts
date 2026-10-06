import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { AuthUser } from '../common/auth-user';
import { CurrentUser, ReqMeta, RequestMeta, RequirePermission } from '../common/decorators';
import { Permission } from '../common/permissions';
import { AddMembersDto, CreateGroupDto, RenameGroupDto } from './groups.dto';
import { GroupsService } from './groups.service';

/** Group management is Admin-only (groups.manage). Groups scope approval routing; they are not content owners. */
@Controller('groups')
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  @Get()
  @RequirePermission(Permission.GroupsManage)
  list(@CurrentUser() actor: AuthUser) {
    return this.groups.list(actor);
  }

  @Post()
  @RequirePermission(Permission.GroupsManage)
  create(@CurrentUser() actor: AuthUser, @Body() dto: CreateGroupDto, @ReqMeta() meta: RequestMeta) {
    return this.groups.create(actor, dto.name, meta);
  }

  @Get(':id')
  @RequirePermission(Permission.GroupsManage)
  get(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.groups.get(actor, id);
  }

  @Patch(':id')
  @RequirePermission(Permission.GroupsManage)
  rename(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RenameGroupDto, @ReqMeta() meta: RequestMeta) {
    return this.groups.rename(actor, id, dto.name, meta);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission(Permission.GroupsManage)
  async remove(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    await this.groups.remove(actor, id, meta);
  }

  @Post(':id/members')
  @HttpCode(200)
  @RequirePermission(Permission.GroupsManage)
  addMembers(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddMembersDto, @ReqMeta() meta: RequestMeta) {
    return this.groups.addMembers(actor, id, dto.userIds, meta);
  }

  @Delete(':id/members/:userId')
  @RequirePermission(Permission.GroupsManage)
  removeMember(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.groups.removeMember(actor, id, userId, meta);
  }
}
