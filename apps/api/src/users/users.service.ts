import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrgRole, User, UserStatus } from '@prisma/client';
import { randomBytes } from 'crypto';
import { AuditAction, AuditService } from '../audit/audit.service';
import { splitCsvLine } from '../common/csv';
import { hashToken, TokenService } from '../auth/token.service';
import { normaliseEmail } from '../auth/auth.service';
import { AuthUser } from '../common/auth-user';
import { ASSIGNABLE_ROLES } from '../common/permissions';
import { RequestMeta } from '../common/decorators';
import { env } from '../config/env';
import { MailService } from '../mail/mail.service';
import { isUniqueViolation, PrismaService } from '../prisma/prisma.service';
import { InviteDto } from './users.dto';

export const INVITE_TTL_DAYS = 7;

const USER_SELECT = {
  id: true,
  email: true,
  name: true,
  status: true,
  orgRole: true,
  lastLoginAt: true,
  createdAt: true,
  mfaEnabled: true,
} as const;

export interface BulkInviteResult {
  created: { email: string; role: OrgRole; invitationId: string }[];
  errors: { row: number; email?: string; error: string }[];
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  list(actor: AuthUser) {
    return this.prisma.user.findMany({
      where: { organizationId: actor.organizationId },
      select: USER_SELECT,
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
    });
  }

  listInvitations(actor: AuthUser) {
    return this.prisma.invitation.findMany({
      where: { organizationId: actor.organizationId, status: 'pending' },
      select: { id: true, email: true, orgRole: true, expiresAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ───────────── role hierarchy (§7.2 "Change a user's role") ─────────────

  /** Roles an actor may assign via invite or role change. Ownership transfer is out of scope. */
  private assertAssignable(actor: AuthUser, role: OrgRole) {
    if (role === 'OWNER') throw new ForbiddenException('The Owner role cannot be assigned');
    if (!ASSIGNABLE_ROLES.includes(role)) throw new BadRequestException('Role must be Admin, Editor or Viewer');
    if (actor.role === 'ADMIN' && role === 'ADMIN') {
      throw new ForbiddenException('Admins cannot grant the Admin role');
    }
  }

  /** Whether `actor` may modify `target` (role, suspend, remove). */
  private assertCanManage(actor: AuthUser, target: User) {
    if (target.id === actor.id) throw new ForbiddenException('You cannot change your own account here');
    if (target.orgRole === 'OWNER') throw new ForbiddenException('The Owner account cannot be modified');
    if (actor.role === 'ADMIN' && target.orgRole === 'ADMIN') {
      throw new ForbiddenException('Admins cannot modify other Admins');
    }
  }

  /** Tenant-scoped lookup — a user in another org is indistinguishable from a missing one (404). */
  private async findTarget(actor: AuthUser, id: string): Promise<User> {
    const target = await this.prisma.user.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!target) throw new NotFoundException('User not found');
    return target;
  }

  // ───────────── invitations ─────────────

  async invite(actor: AuthUser, dto: InviteDto, meta: RequestMeta) {
    this.assertAssignable(actor, dto.role);
    const email = normaliseEmail(dto.email);
    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw new ConflictException('A user with this email already exists');
    }
    const raw = randomBytes(32).toString('base64url');
    const invitation = await this.prisma.$transaction(async (tx) => {
      // Re-inviting supersedes any pending invitation for the same email.
      await tx.invitation.updateMany({
        where: { organizationId: actor.organizationId, email, status: 'pending' },
        data: { status: 'revoked' },
      });
      const inv = await tx.invitation.create({
        data: {
          organizationId: actor.organizationId,
          email,
          orgRole: dto.role,
          tokenHash: hashToken(raw),
          invitedById: actor.id,
          expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000),
        },
      });
      await this.audit.record(
        {
          action: AuditAction.UserInvited,
          organizationId: actor.organizationId,
          actorId: actor.id,
          entityType: 'invitation',
          entityId: inv.id,
          metadata: { email, role: dto.role },
          ...meta,
        },
        tx,
      );
      return inv;
    });

    const inviteUrl = `${env.publicAppUrl}/invite/${raw}`;
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: actor.organizationId } });
    await this.mail.send({
      to: email,
      subject: `You're invited to ${org.name} on GembaDocs`,
      text: `${actor.name} invited you to join ${org.name} as ${dto.role}.\n\nAccept: ${inviteUrl}\n\nThis link expires in ${INVITE_TTL_DAYS} days.`,
    });
    return { id: invitation.id, email, role: dto.role, expiresAt: invitation.expiresAt, inviteUrl };
  }

  async bulkInvite(actor: AuthUser, rows: InviteDto[] | undefined, csv: string | undefined, meta: RequestMeta): Promise<BulkInviteResult> {
    const parsed = rows?.map((r, i) => ({ row: i + 1, email: r.email, role: r.role as string })) ?? parseInviteCsv(csv ?? '');
    if (parsed.length === 0) throw new BadRequestException('No invitations supplied');
    if (parsed.length > 500) throw new BadRequestException('At most 500 invitations per request');

    const result: BulkInviteResult = { created: [], errors: [] };
    const seen = new Set<string>();
    for (const r of parsed) {
      const email = r.email ? normaliseEmail(r.email) : '';
      const raw = r.role?.trim().toUpperCase();
      const role = raw === 'VIEWER' ? 'OPERATOR' : raw; // "Viewer" is the display name of OPERATOR
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        result.errors.push({ row: r.row, email: r.email, error: 'Invalid email' });
        continue;
      }
      if (!role || !(role in OrgRole)) {
        result.errors.push({ row: r.row, email, error: `Invalid role "${r.role ?? ''}"` });
        continue;
      }
      if (seen.has(email)) {
        result.errors.push({ row: r.row, email, error: 'Duplicate email in upload' });
        continue;
      }
      seen.add(email);
      try {
        const inv = await this.invite(actor, { email, role: role as OrgRole }, meta);
        result.created.push({ email, role: role as OrgRole, invitationId: inv.id });
      } catch (e) {
        result.errors.push({ row: r.row, email, error: e instanceof Error ? e.message : 'Failed' });
      }
    }
    return result;
  }

  async revokeInvitation(actor: AuthUser, id: string, meta: RequestMeta) {
    const inv = await this.prisma.invitation.findFirst({
      where: { id, organizationId: actor.organizationId, status: 'pending' },
    });
    if (!inv) throw new NotFoundException('Invitation not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.invitation.update({ where: { id }, data: { status: 'revoked' } });
      await this.audit.record(
        { action: AuditAction.UserInviteRevoked, organizationId: actor.organizationId, actorId: actor.id, entityType: 'invitation', entityId: id, metadata: { email: inv.email }, ...meta },
        tx,
      );
    });
  }

  /** Public lookup used by the accept-invite page. */
  async describeInvitation(raw: string) {
    const inv = await this.prisma.invitation.findUnique({
      where: { tokenHash: hashToken(raw) },
      include: { organization: { select: { name: true, status: true } } },
    });
    if (!inv || inv.status !== 'pending' || inv.expiresAt <= new Date() || inv.organization.status !== 'active') {
      throw new NotFoundException('Invitation is invalid or has expired');
    }
    return { email: inv.email, role: inv.orgRole, organizationName: inv.organization.name };
  }

  async acceptInvitation(raw: string, name: string, passwordHash: string, meta: RequestMeta): Promise<User> {
    const inv = await this.prisma.invitation.findUnique({
      where: { tokenHash: hashToken(raw) },
      include: { organization: { select: { status: true } } },
    });
    if (!inv || inv.status !== 'pending' || inv.expiresAt <= new Date() || inv.organization.status !== 'active') {
      throw new NotFoundException('Invitation is invalid or has expired');
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Conditional flip prevents the same invitation being accepted twice concurrently.
        const claimed = await tx.invitation.updateMany({
          where: { id: inv.id, status: 'pending' },
          data: { status: 'accepted', acceptedAt: new Date() },
        });
        if (claimed.count !== 1) throw new NotFoundException('Invitation is invalid or has expired');
        const user = await tx.user.create({
          data: {
            organizationId: inv.organizationId,
            email: inv.email,
            name: name.trim(),
            orgRole: inv.orgRole,
            status: 'active',
            passwordHash,
            createdById: inv.invitedById,
          },
        });
        await tx.invitation.update({ where: { id: inv.id }, data: { userId: user.id } });
        await this.audit.record(
          { action: AuditAction.UserInviteAccepted, organizationId: inv.organizationId, actorId: user.id, entityType: 'user', entityId: user.id, metadata: { invitationId: inv.id, role: inv.orgRole }, ...meta },
          tx,
        );
        return user;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('A user with this email already exists');
      throw e;
    }
  }

  // ───────────── lifecycle (§7.5) ─────────────

  async changeRole(actor: AuthUser, id: string, role: OrgRole, meta: RequestMeta) {
    const target = await this.findTarget(actor, id);
    this.assertCanManage(actor, target);
    this.assertAssignable(actor, role);
    if (target.status === 'removed') throw new BadRequestException('User has been removed');
    if (target.orgRole === role) return this.prisma.user.findUniqueOrThrow({ where: { id }, select: USER_SELECT });

    return this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { orgRole: role } });
      await this.tokens.revokeAllForUser(id, 'role_change', tx);
      await this.audit.record(
        { action: AuditAction.UserRoleChanged, organizationId: actor.organizationId, actorId: actor.id, entityType: 'user', entityId: id, metadata: { from: target.orgRole, to: role }, ...meta },
        tx,
      );
      return tx.user.findUniqueOrThrow({ where: { id }, select: USER_SELECT });
    });
  }

  suspend(actor: AuthUser, id: string, meta: RequestMeta) {
    return this.transition(actor, id, ['active'], 'suspended', AuditAction.UserSuspended, meta);
  }

  reactivate(actor: AuthUser, id: string, meta: RequestMeta) {
    return this.transition(actor, id, ['suspended'], 'active', AuditAction.UserReactivated, meta);
  }

  /** Permanent login block; the row is retained for historical references (Invariant #16). */
  remove(actor: AuthUser, id: string, meta: RequestMeta) {
    return this.transition(actor, id, ['active', 'suspended', 'invited'], 'removed', AuditAction.UserRemoved, meta);
  }

  /** Admin recovery when a user lost their authenticator: MFA off + all sessions revoked. */
  async resetMfa(actor: AuthUser, id: string, meta: RequestMeta) {
    const target = await this.findTarget(actor, id);
    this.assertCanManage(actor, target);
    return this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { mfaEnabled: false, mfaSecretEnc: null, mfaPendingSecretEnc: null, mfaLastStep: null } });
      await this.tokens.revokeAllForUser(id, 'mfa_reset', tx);
      await this.audit.record(
        { action: AuditAction.MfaChanged, organizationId: actor.organizationId, actorId: actor.id, entityType: 'user', entityId: id, metadata: { enabled: false, resetBy: actor.id }, ...meta },
        tx,
      );
      return tx.user.findUniqueOrThrow({ where: { id }, select: USER_SELECT });
    });
  }

  private async transition(
    actor: AuthUser,
    id: string,
    from: UserStatus[],
    to: UserStatus,
    action: (typeof AuditAction)[keyof typeof AuditAction],
    meta: RequestMeta,
  ) {
    const target = await this.findTarget(actor, id);
    this.assertCanManage(actor, target);
    if (!from.includes(target.status)) {
      throw new BadRequestException(`Cannot change status from ${target.status} to ${to}`);
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { status: to } });
      if (to !== 'active') await this.tokens.revokeAllForUser(id, `status_${to}`, tx);
      await this.audit.record(
        { action, organizationId: actor.organizationId, actorId: actor.id, entityType: 'user', entityId: id, metadata: { from: target.status, to }, ...meta },
        tx,
      );
      return tx.user.findUniqueOrThrow({ where: { id }, select: USER_SELECT });
    });
  }
}

/** Minimal CSV parser for `email,role` uploads (header row optional, quotes supported). */
export function parseInviteCsv(csv: string): { row: number; email?: string; role?: string }[] {
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/);
  const out: { row: number; email?: string; role?: string }[] = [];
  let emailIdx = 0;
  let roleIdx = 1;
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const cells = splitCsvLine(line).map((c) => c.trim());
    const lower = cells.map((c) => c.toLowerCase());
    if (i === 0 && lower.includes('email')) {
      emailIdx = lower.indexOf('email');
      roleIdx = lower.indexOf('role');
      return;
    }
    out.push({ row: i + 1, email: cells[emailIdx], role: roleIdx >= 0 ? cells[roleIdx] : undefined });
  });
  return out;
}
