import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import { AuthUser } from './auth-user';
import { Permission } from './permissions';

export const IS_PUBLIC_KEY = 'gemba:isPublic';
export const PERMISSION_KEY = 'gemba:permission';

/** Route requires no authentication. Must be declared explicitly. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Route requires an authenticated user whose role grants `permission` (§7.2). */
export const RequirePermission = (permission: Permission) => SetMetadata(PERMISSION_KEY, permission);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
  if (!req.user) throw new Error('CurrentUser used on a route without authentication');
  return req.user;
});

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

export const ReqMeta = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestMeta => {
  const req = ctx.switchToHttp().getRequest<Request>();
  return { ip: req.ip, userAgent: req.get('user-agent') ?? undefined };
});
