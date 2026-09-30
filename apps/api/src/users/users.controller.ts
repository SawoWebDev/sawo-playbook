import { TrackActivity } from '../analytics/activity.service';
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { AuthUser } from '../common/auth-user';
import { CurrentUser, ReqMeta, RequestMeta, RequirePermission } from '../common/decorators';
import { Permission } from '../common/permissions';
import { BulkInviteDto, ChangeRoleDto, InviteDto } from './users.dto';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermission(Permission.UsersManage)
  list(@CurrentUser() actor: AuthUser) {
    return this.users.list(actor);
  }

  @Get('invitations')
  @RequirePermission(Permission.UsersManage)
  invitations(@CurrentUser() actor: AuthUser) {
    return this.users.listInvitations(actor);
  }

  @Post('invitations')
  @RequirePermission(Permission.UsersManage)
  @TrackActivity({ event: 'user.invited', entity: 'invitation', id: 'result:id' })
  invite(@CurrentUser() actor: AuthUser, @Body() dto: InviteDto, @ReqMeta() meta: RequestMeta) {
    return this.users.invite(actor, dto, meta);
  }

  @Post('invitations/bulk')
  @RequirePermission(Permission.UsersManage)
  bulkInvite(@CurrentUser() actor: AuthUser, @Body() dto: BulkInviteDto, @ReqMeta() meta: RequestMeta) {
    return this.users.bulkInvite(actor, dto.invites, dto.csv, meta);
  }

  @Delete('invitations/:id')
  @HttpCode(204)
  @RequirePermission(Permission.UsersManage)
  async revokeInvitation(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    await this.users.revokeInvitation(actor, id, meta);
  }

  @Patch(':id/role')
  @RequirePermission(Permission.UsersChangeRole)
  changeRole(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeRoleDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.users.changeRole(actor, id, dto.role, meta);
  }

  @Post(':id/suspend')
  @HttpCode(200)
  @RequirePermission(Permission.UsersManage)
  suspend(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.users.suspend(actor, id, meta);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @RequirePermission(Permission.UsersManage)
  reactivate(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.users.reactivate(actor, id, meta);
  }

  @Post(':id/remove')
  @HttpCode(200)
  @RequirePermission(Permission.UsersManage)
  remove(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.users.remove(actor, id, meta);
  }

  @Post(':id/mfa/reset')
  @HttpCode(200)
  @RequirePermission(Permission.UsersManage)
  resetMfa(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.users.resetMfa(actor, id, meta);
  }
}
