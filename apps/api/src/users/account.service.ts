import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';
import QRCode from 'qrcode';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AuthService, normaliseEmail, SessionTokens } from '../auth/auth.service';
import { hashToken, TokenService } from '../auth/token.service';
import { decryptSecret, encryptSecret, generateSecret, otpauthUri, verifyTotp } from '../auth/totp';
import { AuthUser } from '../common/auth-user';
import { RequestMeta } from '../common/decorators';
import { env } from '../config/env';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from './users.service';

export const RESET_TTL_MINUTES = 60;

/** Self-service account operations (§7.5 "self-service profile", password reset, MFA). */
@Injectable()
export class AccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  async acceptInvite(token: string, name: string, password: string, meta: RequestMeta): Promise<SessionTokens> {
    const user = await this.users.acceptInvitation(token, name, await argon2.hash(password), meta);
    return this.auth.startSession(user, meta);
  }

  async profile(actor: AuthUser) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
    return { id: u.id, name: u.name, email: u.email, role: u.orgRole, organizationId: u.organizationId, mfaEnabled: u.mfaEnabled };
  }

  async updateProfile(actor: AuthUser, name: string) {
    await this.prisma.user.update({ where: { id: actor.id }, data: { name: name.trim() } });
    return this.profile(actor);
  }

  /** Changing the password revokes every session, then starts a fresh one for the caller. */
  async changePassword(actor: AuthUser, current: string, next: string, meta: RequestMeta): Promise<SessionTokens> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
    if (!user.passwordHash || !(await argon2.verify(user.passwordHash, current).catch(() => false))) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    if (current === next) throw new BadRequestException('New password must differ from the current one');
    const passwordHash = await argon2.hash(next);
    const updated = await this.prisma.$transaction(async (tx) => {
      // Setting a password also clears a temporary-password requirement.
      await tx.user.update({ where: { id: user.id }, data: { passwordHash, passwordMustChange: false } });
      await this.tokens.revokeAllForUser(user.id, 'password_change', tx);
      await this.audit.record(
        { action: AuditAction.PasswordReset, organizationId: user.organizationId, actorId: user.id, entityType: 'user', entityId: user.id, metadata: { via: 'self_service' }, ...meta },
        tx,
      );
      return tx.user.findUniqueOrThrow({ where: { id: user.id } });
    });
    return this.auth.startSession(updated, meta);
  }

  /** Always resolves (no account enumeration). */
  async forgotPassword(emailInput: string, meta: RequestMeta): Promise<void> {
    const email = normaliseEmail(emailInput);
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.status !== 'active') return;
    const raw = randomBytes(32).toString('base64url');
    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(raw),
        expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000),
      },
    });
    await this.mail.send({
      to: email,
      subject: 'Reset your SAWO Playbook password',
      text: `Reset your password: ${env.publicAppUrl}/reset-password/${raw}\n\nThis link expires in ${RESET_TTL_MINUTES} minutes. If you did not request it, ignore this email.`,
    });
    void meta;
  }

  async resetPassword(raw: string, newPassword: string, meta: RequestMeta): Promise<void> {
    const rec = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashToken(raw) },
      include: { user: true },
    });
    if (!rec || rec.usedAt || rec.expiresAt <= new Date() || rec.user.status !== 'active') {
      throw new BadRequestException('Reset link is invalid or has expired');
    }
    const passwordHash = await argon2.hash(newPassword);
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.passwordResetToken.updateMany({
        where: { id: rec.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (claimed.count !== 1) throw new BadRequestException('Reset link is invalid or has expired');
      await tx.user.update({
        where: { id: rec.userId },
        data: { passwordHash, failedLogins: 0, lockedUntil: null },
      });
      // §7.4: password reset revokes all refresh-token families.
      await this.tokens.revokeAllForUser(rec.userId, 'password_reset', tx);
      await this.audit.record(
        { action: AuditAction.PasswordReset, organizationId: rec.user.organizationId, actorId: rec.userId, entityType: 'user', entityId: rec.userId, metadata: { via: 'reset_link' }, ...meta },
        tx,
      );
    });
  }

  // ───────────── MFA (TOTP) ─────────────

  /** Step 1: generate a pending secret; returned once so the user can add it to an authenticator app. */
  async mfaSetup(actor: AuthUser) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
    if (user.mfaEnabled) throw new BadRequestException('MFA is already enabled');
    const secret = generateSecret();
    await this.prisma.user.update({ where: { id: user.id }, data: { mfaPendingSecretEnc: encryptSecret(secret) } });
    const uri = otpauthUri(secret, user.email);
    return { secret, otpauthUri: uri, qrDataUrl: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
  }

  /** Step 2: confirm with a code from the app; all other sessions are revoked. */
  async mfaEnable(actor: AuthUser, code: string, meta: RequestMeta): Promise<SessionTokens> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
    if (user.mfaEnabled) throw new BadRequestException('MFA is already enabled');
    if (!user.mfaPendingSecretEnc) throw new BadRequestException('Start MFA setup first');
    const step = verifyTotp(decryptSecret(user.mfaPendingSecretEnc), code.trim());
    if (step === null) throw new BadRequestException('Invalid authentication code');
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { mfaEnabled: true, mfaSecretEnc: user.mfaPendingSecretEnc, mfaPendingSecretEnc: null, mfaLastStep: step },
      });
      await this.tokens.revokeAllForUser(user.id, 'mfa_enabled', tx);
      await this.audit.record(
        { action: AuditAction.MfaChanged, organizationId: user.organizationId, actorId: user.id, entityType: 'user', entityId: user.id, metadata: { enabled: true }, ...meta },
        tx,
      );
      return tx.user.findUniqueOrThrow({ where: { id: user.id } });
    });
    return this.auth.startSession(updated, meta);
  }

  /** Requires both the password and a current code. */
  async mfaDisable(actor: AuthUser, password: string, code: string, meta: RequestMeta) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
    if (!user.mfaEnabled || !user.mfaSecretEnc) throw new BadRequestException('MFA is not enabled');
    if (!user.passwordHash || !(await argon2.verify(user.passwordHash, password).catch(() => false))) {
      throw new UnauthorizedException('Password is incorrect');
    }
    if (verifyTotp(decryptSecret(user.mfaSecretEnc), code.trim()) === null) throw new BadRequestException('Invalid authentication code');
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { mfaEnabled: false, mfaSecretEnc: null, mfaPendingSecretEnc: null, mfaLastStep: null } });
      await this.audit.record(
        { action: AuditAction.MfaChanged, organizationId: user.organizationId, actorId: user.id, entityType: 'user', entityId: user.id, metadata: { enabled: false }, ...meta },
        tx,
      );
    });
    return this.profile(actor);
  }
}
