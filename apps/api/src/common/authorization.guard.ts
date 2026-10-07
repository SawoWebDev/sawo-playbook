import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { orgIsUsable } from './org-status';
import { AccessTokenPayload, AuthUser } from './auth-user';
import { ALLOW_WHILE_PASSWORD_CHANGE_KEY, BLOCK_WHILE_IMPERSONATING_KEY, IS_PUBLIC_KEY, PERMISSION_KEY } from './decorators';
import { Permission, userPermissions } from './permissions';

/**
 * Global guard (§7.3 rules 1, 2, 7, 9):
 *  - deny-by-default: every route must declare @Public() or @RequirePermission();
 *  - verifies the access JWT, then re-reads the user so that status, role and
 *    tokenVersion are authoritative from the DB, not from the token;
 *  - organizationId is taken only from the DB user row.
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const permission = this.reflector.getAllAndOverride<Permission>(PERMISSION_KEY, targets);
    if (!permission) {
      throw new InternalServerErrorException('Route has no declared permission');
    }

    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const user = await this.authenticate(req);
    req.user = user;

    if (!user.permissions.has(permission)) {
      throw new ForbiddenException('Insufficient permission');
    }
    if (user.impersonatedBy && this.reflector.getAllAndOverride<boolean>(BLOCK_WHILE_IMPERSONATING_KEY, targets)) {
      throw new ForbiddenException('Not available while impersonating - go back to your admin account first');
    }
    // A temporary password must be replaced before anything else is usable. The identity read and the change itself stay open.
    const allowWhilePending = this.reflector.getAllAndOverride<boolean>(ALLOW_WHILE_PASSWORD_CHANGE_KEY, targets);
    if (user.passwordMustChange && !allowWhilePending) {
      throw new ForbiddenException('Password change required');
    }
    return true;
  }

  private async authenticate(req: Request): Promise<AuthUser> {
    const header = req.get('authorization');
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException();
    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(header.slice(7), {
        secret: env.jwtAccessSecret,
        algorithms: ['HS256'],
      });
    } catch {
      throw new UnauthorizedException();
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: {
        organization: { select: { status: true, settings: { select: { rolePermissions: true } } } },
        groupMemberships: { select: { groupId: true } },
      },
    });
    if (
      !user ||
      // An Admin may impersonate someone who has not accepted their invitation yet, so invited accounts pass on an impersonation token.
      (user.status !== 'active' && !(payload.imp && user.status === 'invited')) ||
      user.tokenVersion !== payload.tv ||
      user.organizationId !== payload.org ||
      !orgIsUsable(user.organization.status)
    ) {
      throw new UnauthorizedException();
    }
    // An impersonation token is only honoured while the Admin who started it is still an active, users.manage-capable
    // user of the same organization, so suspending or demoting them ends every session they opened.
    let impersonatedBy: AuthUser['impersonatedBy'];
    if (payload.imp) {
      const admin = await this.prisma.user.findUnique({
        where: { id: payload.imp },
        include: { organization: { select: { settings: { select: { rolePermissions: true } } } } },
      });
      const adminCan =
        !!admin &&
        admin.status === 'active' &&
        admin.organizationId === user.organizationId &&
        userPermissions(admin.orgRole, admin.organization.settings?.rolePermissions, admin.extraPermissions).has(Permission.UsersManage);
      if (!admin || !adminCan) throw new UnauthorizedException();
      impersonatedBy = { id: admin.id, name: admin.name };
    }
    // Permissions are read from the DB on every request, so an admin's change takes effect immediately.
    return {
      id: user.id,
      organizationId: user.organizationId,
      role: user.orgRole,
      email: user.email,
      name: user.name,
      permissions: userPermissions(user.orgRole, user.organization.settings?.rolePermissions, user.extraPermissions),
      groupIds: user.groupMemberships.map((m) => m.groupId),
      passwordMustChange: user.passwordMustChange,
      ...(impersonatedBy ? { impersonatedBy } : {}),
    };
  }
}
