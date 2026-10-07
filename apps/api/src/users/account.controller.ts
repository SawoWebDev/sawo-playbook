import { Body, Controller, Get, HttpCode, Param, Patch, Post, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { setRefreshCookie, sessionBody } from '../auth/auth.controller';
import { AuthUser } from '../common/auth-user';
import { AllowWhilePasswordChangeRequired, BlockWhileImpersonating, CurrentUser, Public, ReqMeta, RequestMeta, RequirePermission } from '../common/decorators';
import { Permission } from '../common/permissions';
import { AccountService } from './account.service';
import {
  AcceptInviteDto,
  ChangePasswordDto,
  ForgotPasswordDto,
  MfaCodeDto,
  MfaDisableDto,
  ResetPasswordDto,
  UpdateProfileDto,
} from './users.dto';
import { UsersService } from './users.service';

@Controller()
@Throttle({ default: { limit: 10, ttl: 60_000 } })
export class AccountController {
  constructor(
    private readonly account: AccountService,
    private readonly users: UsersService,
  ) {}

  @Public()
  @Get('auth/invitations/:token')
  describeInvitation(@Param('token') token: string) {
    return this.users.describeInvitation(token);
  }

  @Public()
  @Post('auth/accept-invite')
  async acceptInvite(@Body() dto: AcceptInviteDto, @ReqMeta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    const s = await this.account.acceptInvite(dto.token, dto.name, dto.password, meta);
    setRefreshCookie(res, s.refreshToken);
    return sessionBody(s);
  }

  @Public()
  @Post('auth/forgot-password')
  @HttpCode(204)
  async forgot(@Body() dto: ForgotPasswordDto, @ReqMeta() meta: RequestMeta) {
    await this.account.forgotPassword(dto.email, meta);
  }

  @Public()
  @Post('auth/reset-password')
  @HttpCode(204)
  async reset(@Body() dto: ResetPasswordDto, @ReqMeta() meta: RequestMeta) {
    await this.account.resetPassword(dto.token, dto.newPassword, meta);
  }

  @Patch('profile')
  @RequirePermission(Permission.Authenticated)
  updateProfile(@CurrentUser() actor: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.account.updateProfile(actor, dto.name);
  }

  @Post('profile/password')
  @BlockWhileImpersonating()
  @HttpCode(200)
  @RequirePermission(Permission.Authenticated)
  @AllowWhilePasswordChangeRequired()
  async changePassword(
    @CurrentUser() actor: AuthUser,
    @Body() dto: ChangePasswordDto,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    const s = await this.account.changePassword(actor, dto.currentPassword, dto.newPassword, meta);
    setRefreshCookie(res, s.refreshToken);
    return sessionBody(s);
  }

  @Get('profile')
  @RequirePermission(Permission.Authenticated)
  profile(@CurrentUser() actor: AuthUser) {
    return this.account.profile(actor);
  }

  @Post('profile/mfa/setup')
  @BlockWhileImpersonating()
  @HttpCode(200)
  @RequirePermission(Permission.Authenticated)
  mfaSetup(@CurrentUser() actor: AuthUser) {
    return this.account.mfaSetup(actor);
  }

  @Post('profile/mfa/enable')
  @BlockWhileImpersonating()
  @HttpCode(200)
  @RequirePermission(Permission.Authenticated)
  async mfaEnable(@CurrentUser() actor: AuthUser, @Body() dto: MfaCodeDto, @ReqMeta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    const s = await this.account.mfaEnable(actor, dto.code, meta);
    setRefreshCookie(res, s.refreshToken);
    return sessionBody(s);
  }

  @Post('profile/mfa/disable')
  @BlockWhileImpersonating()
  @HttpCode(200)
  @RequirePermission(Permission.Authenticated)
  mfaDisable(@CurrentUser() actor: AuthUser, @Body() dto: MfaDisableDto, @ReqMeta() meta: RequestMeta) {
    return this.account.mfaDisable(actor, dto.password, dto.code, meta);
  }
}
