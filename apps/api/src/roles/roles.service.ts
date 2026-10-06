import { BadRequestException, Injectable } from '@nestjs/common';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth-user';
import { RequestMeta } from '../common/decorators';
import {
  ADMIN_ONLY_PERMISSIONS,
  CONFIGURABLE_PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
  effectivePermissions,
  Permission,
  ROLE_LABELS,
} from '../common/permissions';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Roles an Admin can configure. Admin itself always holds every permission and is not editable. */
const CONFIGURABLE_ROLES = ['OPERATOR', 'EDITOR', 'PRE_APPROVER', 'APPROVER'] as const;
const ALL_ROLES = ['ADMIN', ...CONFIGURABLE_ROLES] as const;
type ConfigurableRole = (typeof CONFIGURABLE_ROLES)[number];

/**
 * Role permission management. The stored overrides live on organization_settings.role_permissions and are read by
 * AuthorizationGuard on every request, so a change applies to the next request, not the next login.
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(actor: AuthUser) {
    const settings = await this.settings(actor);
    return {
      roles: ALL_ROLES.map((role) => {
        const stored = settings.rolePermissions as Record<string, unknown> | null;
        const effective = [...effectivePermissions(role, settings.rolePermissions)].filter((p) => p !== Permission.Authenticated).sort();
        return {
          role,
          label: ROLE_LABELS[role],
          locked: role === 'ADMIN',
          customised: role !== 'ADMIN' && !!stored && Array.isArray(stored[role]),
          permissions: effective,
        };
      }),
      configurable: [...CONFIGURABLE_PERMISSIONS].sort(),
      adminOnly: [...ADMIN_ONLY_PERMISSIONS].sort(),
      defaults: Object.fromEntries(CONFIGURABLE_ROLES.map((r) => [r, [...DEFAULT_ROLE_PERMISSIONS[r]].sort()])),
    };
  }

  /** Replaces a role's permission list. Only configurable permissions may be granted to a non-Admin role. */
  async update(actor: AuthUser, role: string, permissions: string[], meta: RequestMeta) {
    const target = this.assertConfigurable(role);
    const requested = [...new Set(permissions)];
    const allowed = new Set<string>(CONFIGURABLE_PERMISSIONS);
    const rejected = requested.filter((p) => !allowed.has(p));
    if (rejected.length) {
      throw new BadRequestException(`These permissions cannot be granted to ${ROLE_LABELS[target]}: ${rejected.join(', ')}`);
    }
    await this.prisma.$transaction(async (tx) => {
      const settings = await tx.organizationSettings.findUniqueOrThrow({ where: { organizationId: actor.organizationId }, select: { rolePermissions: true } });
      const before: string[] = [...effectivePermissions(target, settings.rolePermissions)].filter((p) => p !== Permission.Authenticated).sort();
      const next = { ...((settings.rolePermissions as Record<string, unknown> | null) ?? {}), [target]: requested.sort() } as Prisma.InputJsonValue;
      await tx.organizationSettings.update({ where: { organizationId: actor.organizationId }, data: { rolePermissions: next } });
      await this.audit.record(
        { action: AuditAction.RolePermissionsChanged, organizationId: actor.organizationId, actorId: actor.id, entityType: 'organization_settings', entityId: actor.organizationId, metadata: { role: target, before, after: [...requested].sort(), added: requested.filter((p) => !before.includes(p)), removed: before.filter((p) => !requested.includes(p)) }, ...meta },
        tx,
      );
    });
    return this.list(actor);
  }

  /** Removes the organisation's override for a role, so it returns to the approved defaults. */
  async reset(actor: AuthUser, role: string, meta: RequestMeta) {
    const target = this.assertConfigurable(role);
    await this.prisma.$transaction(async (tx) => {
      const settings = await tx.organizationSettings.findUniqueOrThrow({ where: { organizationId: actor.organizationId }, select: { rolePermissions: true } });
      const current = (settings.rolePermissions as Record<string, unknown> | null) ?? {};
      const { [target]: _removed, ...rest } = current;
      await tx.organizationSettings.update({ where: { organizationId: actor.organizationId }, data: { rolePermissions: Object.keys(rest).length ? (rest as Prisma.InputJsonValue) : Prisma.DbNull } });
      await this.audit.record({ action: AuditAction.RolePermissionsChanged, organizationId: actor.organizationId, actorId: actor.id, entityType: 'organization_settings', entityId: actor.organizationId, metadata: { role: target, reset: true }, ...meta }, tx);
    });
    return this.list(actor);
  }

  private assertConfigurable(role: string): ConfigurableRole {
    if (role === 'ADMIN') throw new BadRequestException('Admin permissions are fixed and cannot be changed');
    if (!(CONFIGURABLE_ROLES as readonly string[]).includes(role)) throw new BadRequestException('Unknown role');
    return role as ConfigurableRole;
  }

  private settings(actor: AuthUser) {
    return this.prisma.organizationSettings.findUniqueOrThrow({ where: { organizationId: actor.organizationId }, select: { rolePermissions: true } });
  }
}
