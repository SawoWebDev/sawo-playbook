import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthUser } from '../common/auth-user';
import { CurrentUser, Public, ReqMeta, RequestMeta, RequirePermission } from '../common/decorators';
import { Permission } from '../common/permissions';
import { env } from '../config/env';
import { LoginDto, LoginMfaDto, SignupDto } from './auth.dto';
import { AuthService, SessionTokens } from './auth.service';

export const REFRESH_COOKIE = 'gemba_rt';
/** Cookie is scoped to the refresh endpoint only (§7.4). */
export const REFRESH_COOKIE_PATH = '/api/auth/refresh';

export function setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: env.cookieSecure,
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
    maxAge: env.refreshTtlDays * 86_400_000,
  });
}

function clearRefreshCookie(res: Response) {
  res.clearCookie(REFRESH_COOKIE, { httpOnly: true, secure: env.cookieSecure, sameSite: 'strict', path: REFRESH_COOKIE_PATH });
}

export function sessionBody(s: SessionTokens) {
  return { accessToken: s.accessToken, expiresIn: env.jwtAccessTtlSeconds, user: s.user };
}

@Controller('auth')
@Throttle({ default: { limit: 10, ttl: 60_000 } })
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('signup')
  async signup(@Body() dto: SignupDto, @ReqMeta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    const s = await this.auth.signup(dto, meta);
    setRefreshCookie(res, s.refreshToken);
    return sessionBody(s);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @ReqMeta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    const s = await this.auth.login(dto, meta);
    if ('mfaRequired' in s) return s;
    setRefreshCookie(res, s.refreshToken);
    return sessionBody(s);
  }

  @Public()
  @Post('login/mfa')
  @HttpCode(200)
  async loginMfa(@Body() dto: LoginMfaDto, @ReqMeta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    const s = await this.auth.loginMfa(dto.mfaToken, dto.code, meta);
    setRefreshCookie(res, s.refreshToken);
    return sessionBody(s);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async refresh(@Req() req: Request, @ReqMeta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    try {
      const s = await this.auth.refresh(req.cookies?.[REFRESH_COOKIE], meta);
      setRefreshCookie(res, s.refreshToken);
      return sessionBody(s);
    } catch (e) {
      clearRefreshCookie(res);
      throw e;
    }
  }

  @Public()
  @Post('refresh/logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @ReqMeta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE], {}, meta);
    clearRefreshCookie(res);
  }

  @Get('me')
  @RequirePermission(Permission.Authenticated)
  /**
   * The caller's identity plus the authorisation context the frontend needs for display only. Both values come from
   * the guard's per-request load (the same source the guard enforces), so this adds no second permission calculation.
   * The server still checks every request itself.
   */
  me(@CurrentUser() user: AuthUser) {
    return {
      id: user.id,
      organizationId: user.organizationId,
      role: user.role,
      email: user.email,
      name: user.name,
      permissions: [...user.permissions].filter((p) => p !== Permission.Authenticated).sort(),
      groupIds: [...user.groupIds].sort(),
    };
  }
}
