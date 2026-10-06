import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { AuthUser } from '../common/auth-user';
import { CurrentUser, ReqMeta, RequestMeta, RequirePermission } from '../common/decorators';
import { Permission } from '../common/permissions';
import { SetRolePermissionsDto } from './roles.dto';
import { RolesService } from './roles.service';

/** Role & permission configuration is Admin-only (roles.manage). */
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @RequirePermission(Permission.RolesManage)
  list(@CurrentUser() actor: AuthUser) {
    return this.roles.list(actor);
  }

  @Put(':role')
  @RequirePermission(Permission.RolesManage)
  update(@CurrentUser() actor: AuthUser, @Param('role') role: string, @Body() dto: SetRolePermissionsDto, @ReqMeta() meta: RequestMeta) {
    return this.roles.update(actor, role, dto.permissions, meta);
  }

  @Delete(':role')
  @RequirePermission(Permission.RolesManage)
  reset(@CurrentUser() actor: AuthUser, @Param('role') role: string, @ReqMeta() meta: RequestMeta) {
    return this.roles.reset(actor, role, meta);
  }
}
