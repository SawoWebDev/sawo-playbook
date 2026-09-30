import { Body, Controller, Delete, Get, Patch, Post, Query } from '@nestjs/common';
import { AuthUser } from '../common/auth-user';
import { CurrentUser, ReqMeta, RequestMeta, RequirePermission } from '../common/decorators';
import { Permission } from '../common/permissions';
import { AuditQueryDto, RequestDeletionDto, UpdateSettingsDto } from './organization.dto';
import { OrganizationService } from './organization.service';

@Controller()
export class OrganizationController {
  constructor(private readonly org: OrganizationService) {}

  @Get('organization')
  @RequirePermission(Permission.Authenticated)
  get(@CurrentUser() actor: AuthUser) {
    return this.org.get(actor);
  }

  @Patch('organization/settings')
  @RequirePermission(Permission.OrgSettingsManage)
  updateSettings(@CurrentUser() actor: AuthUser, @Body() dto: UpdateSettingsDto, @ReqMeta() meta: RequestMeta) {
    return this.org.updateSettings(actor, dto, meta);
  }

  @Post('organization/deletion')
  @RequirePermission(Permission.OrgDelete)
  requestDeletion(@CurrentUser() actor: AuthUser, @Body() dto: RequestDeletionDto, @ReqMeta() meta: RequestMeta) {
    return this.org.requestDeletion(actor, dto.confirmName, dto.password, meta);
  }

  @Delete('organization/deletion')
  @RequirePermission(Permission.OrgDelete)
  cancelDeletion(@CurrentUser() actor: AuthUser, @ReqMeta() meta: RequestMeta) {
    return this.org.cancelDeletion(actor, meta);
  }

  @Get('audit-log')
  @RequirePermission(Permission.AuditLogView)
  audit(@CurrentUser() actor: AuthUser, @Query() q: AuditQueryDto) {
    return this.org.listAudit(actor, q);
  }
}
