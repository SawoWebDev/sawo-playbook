import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrgRole, User, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';
import { AuditAction, AuditService } from '../audit/audit.service';
import { splitCsvLine } from '../common/csv';
import { hashToken, TokenService } from '../auth/token.service';
import { normaliseEmail } from '../auth/auth.service';
import { AuthUser } from '../common/auth-user';
import { ASSIGNABLE_ROLES, CONFIGURABLE_PERMISSIONS, isFullAccessRole } from '../common/permissions';
import { RequestMeta } from '../common/decorators';
import { env } from '../config/env';
import { MailService } from '../mail/mail.service';
import { isUniqueViolation, PrismaService } from '../prisma/prisma.service';
import { CreateUserDto, InviteDto } from './users.dto';

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

  async list(actor: AuthUser) {
    const rows = await this.prisma.user.findMany({
      where: { organizationId: actor.organizationId },
      select: { ...USER_SELECT, extraPermissions: true, groupMemberships: { select: { group: { select: { id: true, name: true } } } } },
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
    });
    // Same helper as GET /users/:id, so the list and the detail can never disagree.
    return rows.map(({ groupMemberships, ...u }) => ({
      ...u,
      extraPermissions: [...u.extraPermissions].sort(),
      groups: groupMemberships.map((m) => m.group),
      approvalReadiness: this.approvalReadiness(u),
    }));
  }

  /** One user with groups and approval readiness, for the user detail screen. */
  async get(actor: AuthUser, id: string) {
    const u = await this.findTarget(actor, id);
    const groups = await this.prisma.groupMember.findMany({ where: { userId: id }, select: { group: { select: { id: true, name: true } } } });
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      orgRole: u.orgRole,
      status: u.status,
      mfaEnabled: u.mfaEnabled,
      lastLoginAt: u.lastLoginAt,
      createdAt: u.createdAt,
      groups: groups.map((g) => g.group),
      extraPermissions: [...u.extraPermissions].sort(),
      approvalReadiness: this.approvalReadiness(u),
    };
  }

  /**
   * Replaces one person's extra permissions. Only configurable permissions can be granted, never Admin-only ones.
   * Permissions are read on every request, so the change applies to the person's next request without signing them out.
   */
  async setExtraPermissions(actor: AuthUser, id: string, permissions: string[], meta: RequestMeta) {
    const target = await this.findTarget(actor, id);
    this.assertCanManage(actor, target);
    if (isFullAccessRole(target.orgRole)) throw new BadRequestException('Admins already hold every permission');
    if (target.status === 'removed') throw new BadRequestException('User has been removed');
    const requested = [...new Set(permissions)].sort();
    const allowed = new Set<string>(CONFIGURABLE_PERMISSIONS);
    const rejected = requested.filter((p) => !allowed.has(p));
    if (rejected.length) throw new BadRequestException(`These permissions cannot be granted to a person: ${rejected.join(', ')}`);
    const before = [...target.extraPermissions].sort();
    if (before.length === requested.length && before.every((p, i) => p === requested[i])) return this.get(actor, id);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { extraPermissions: requested } });
      await this.audit.record(
        {
          action: AuditAction.UserPermissionsChanged,
          organizationId: actor.organizationId,
          actorId: actor.id,
          entityType: 'user',
          entityId: id,
          metadata: { before, after: requested, added: requested.filter((p) => !before.includes(p)), removed: before.filter((p) => !requested.includes(p)) },
          ...meta,
        },
        tx,
      );
    });
    return this.get(actor, id);
  }

  /** Pre Approvers and Approvers receive approval mail, so they need a deliverable address. */
  private approvalReadiness(u: Pick<User, 'orgRole' | 'email' | 'status'>): { ready: boolean; issue: string | null } {
    if (u.orgRole !== 'PRE_APPROVER' && u.orgRole !== 'APPROVER') return { ready: true, issue: null };
    if (!u.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(u.email)) return { ready: false, issue: 'Approval email required' };
    if (u.status !== 'active') return { ready: false, issue: 'Account is not active' };
    return { ready: true, issue: null };
  }

  /**
   * Name and email. Changing the email revokes the user's sessions, because the address is their login.
   * Admins cannot edit other Admins (same rule as role changes).
   */
  async updateProfile(actor: AuthUser, id: string, dto: { name?: string; email?: string }, meta: RequestMeta) {
    const target = await this.findTarget(actor, id);
    this.assertCanManage(actor, target);
    const data: { name?: string; email?: string } = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    let emailChanged = false;
    if (dto.email !== undefined) {
      const email = normaliseEmail(dto.email);
      if (email !== target.email) {
        if (await this.prisma.user.findUnique({ where: { email } })) throw new ConflictException('A user with this email already exists');
        data.email = email;
        emailChanged = true;
      }
    }
    if (Object.keys(data).length === 0) return this.get(actor, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data });
      if (emailChanged) await this.tokens.revokeAllForUser(id, 'email_change', tx);
      await this.audit.record(
        { action: AuditAction.UserUpdated, organizationId: actor.organizationId, actorId: actor.id, entityType: 'user', entityId: id, metadata: { fields: Object.keys(data), emailChanged }, ...meta },
        tx,
      );
    });
    return this.get(actor, id);
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
    if (!ASSIGNABLE_ROLES.includes(role)) throw new BadRequestException('Role must be Admin, Viewer, Editor, Pre Approver or Approver');
    // Deliberately `actor.role === 'ADMIN'`, not isFullAccessRole: a legacy OWNER actor is not restricted here today
    // (the invitation and role-change tests rely on that), and isFullAccessRole would change that behaviour.
    if (actor.role === 'ADMIN' && role === 'ADMIN') {
      throw new ForbiddenException('Admins cannot grant the Admin role');
    }
  }

  /** Whether `actor` may modify `target` (role, suspend, remove). */
  private assertCanManage(actor: AuthUser, target: User) {
    if (target.id === actor.id) throw new ForbiddenException('You cannot change your own account here');
    if (actor.role === 'ADMIN' && isFullAccessRole(target.orgRole)) {
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

  /**
   * Creates an active account now, with a temporary password the Admin sets. The user must replace it at first
   * sign-in (passwordMustChange). Same role and group rules as an invitation. The password is hashed here and is
   * never written to the audit trail or returned.
   */
  async createUser(actor: AuthUser, dto: CreateUserDto, meta: RequestMeta) {
    this.assertAssignable(actor, dto.role);
    const groupIds = await this.assertInviteGroups(actor, dto.role, dto.groupIds ?? []);
    const email = normaliseEmail(dto.email);
    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw new ConflictException('A user with this email already exists');
    }
    const passwordHash = await argon2.hash(dto.temporaryPassword);
    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            organizationId: actor.organizationId,
            email,
            name: dto.name.trim(),
            orgRole: dto.role,
            status: 'active',
            passwordHash,
            passwordMustChange: true,
            createdById: actor.id,
          },
        });
        if (groupIds.length) {
          await tx.groupMember.createMany({ data: groupIds.map((groupId) => ({ groupId, userId: created.id, organizationId: actor.organizationId })) });
        }
        await this.audit.record(
          { action: AuditAction.UserCreated, organizationId: actor.organizationId, actorId: actor.id, entityType: 'user', entityId: created.id, metadata: { role: dto.role, groupIds, passwordMustChange: true }, ...meta },
          tx,
        );
        return created;
      });
      return { id: user.id, email: user.email, name: user.name, role: user.orgRole, groupIds, passwordMustChange: true };
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('A user with this email already exists');
      throw e;
    }
  }

  async invite(actor: AuthUser, dto: InviteDto, meta: RequestMeta) {
    this.assertAssignable(actor, dto.role);
    const groupIds = await this.assertInviteGroups(actor, dto.role, dto.groupIds ?? []);
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
          groupIds,
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
      subject: `You're invited to ${org.name} on SAWO Playbook`,
      text: `${actor.name} invited you to join ${org.name} as ${dto.role}.\n\nAccept: ${inviteUrl}\n\nThis link expires in ${INVITE_TTL_DAYS} days.`,
    });
    return { id: invitation.id, email, role: dto.role, expiresAt: invitation.expiresAt, inviteUrl };
  }

  async bulkInvite(actor: AuthUser, rows: InviteDto[] | undefined, csv: string | undefined, meta: RequestMeta): Promise<BulkInviteResult> {
    const parsed: { row: number; email?: string; role?: string; groupIds?: string[]; groups?: string }[] = rows?.map((r, i) => ({ row: i + 1, email: r.email, role: r.role as string, groupIds: r.groupIds, groups: undefined as string | undefined })) ?? parseInviteCsv(csv ?? '');
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
      if (!role || !ASSIGNABLE_ROLES.includes(role as OrgRole)) {
        result.errors.push({ row: r.row, email, error: `Invalid role "${r.role ?? ''}"` });
        continue;
      }
      if (seen.has(email)) {
        result.errors.push({ row: r.row, email, error: 'Duplicate email in upload' });
        continue;
      }
      seen.add(email);
      try {
        const groupIds = r.groups !== undefined ? await this.groupIdsByName(actor, r.groups) : (r.groupIds ?? []);
        const inv = await this.invite(actor, { email, role: role as OrgRole, groupIds }, meta);
        result.created.push({ email, role: role as OrgRole, invitationId: inv.id });
      } catch (e) {
        result.errors.push({ row: r.row, email, error: e instanceof Error ? e.message : 'Failed' });
      }
    }
    return result;
  }

  /** Server-side group rule for invitations: every non-Admin invitation must name at least one existing group of this organisation. */
  private async assertInviteGroups(actor: AuthUser, role: OrgRole, requested: string[]): Promise<string[]> {
    const ids = [...new Set(requested)];
    const found = ids.length ? await this.prisma.userGroup.findMany({ where: { organizationId: actor.organizationId, id: { in: ids } }, select: { id: true } }) : [];
    if (found.length !== ids.length) throw new BadRequestException('One or more groups do not exist in this organisation');
    if (role !== 'ADMIN' && ids.length === 0) {
      throw new BadRequestException('Viewers, Editors, Pre Approvers and Approvers must belong to at least one group');
    }
    return ids;
  }

  /** CSV group column: group names separated by ";". Any unknown name fails that row. */
  private async groupIdsByName(actor: AuthUser, names: string): Promise<string[]> {
    const wanted = [...new Set(names.split(';').map((n) => n.trim()).filter(Boolean))];
    if (wanted.length === 0) return [];
    const groups = await this.prisma.userGroup.findMany({ where: { organizationId: actor.organizationId, name: { in: wanted } }, select: { id: true, name: true } });
    const missing = wanted.filter((n) => !groups.some((g) => g.name === n));
    if (missing.length) throw new BadRequestException(`Unknown group(s): ${missing.join(', ')}`);
    return groups.map((g) => g.id);
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
    if (!inv || inv.status !== 'pending' || inv.expiresAt <= new Date() || inv.organization.status !== 'active' || !ASSIGNABLE_ROLES.includes(inv.orgRole)) {
      throw new NotFoundException('Invitation is invalid or has expired');
    }
    return { email: inv.email, role: inv.orgRole, organizationName: inv.organization.name };
  }

  async acceptInvitation(raw: string, name: string, passwordHash: string, meta: RequestMeta): Promise<User> {
    const inv = await this.prisma.invitation.findUnique({
      where: { tokenHash: hashToken(raw) },
      include: { organization: { select: { status: true } } },
    });
    // The role is the one stored on the invitation: the request never supplies it. Legacy roles are never acceptable.
    if (!inv || inv.status !== 'pending' || inv.expiresAt <= new Date() || inv.organization.status !== 'active' || !ASSIGNABLE_ROLES.includes(inv.orgRole)) {
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
        const groups =
          inv.orgRole === 'ADMIN'
            ? []
            : await tx.userGroup.findMany({ where: { organizationId: inv.organizationId, id: { in: inv.groupIds } }, select: { id: true } });
        // Thrown inside the transaction: the claim above is rolled back too, so the invitation stays usable for an Admin to fix.
        if (inv.orgRole !== 'ADMIN' && groups.length === 0) {
          throw new ConflictException('This invitation no longer has a valid group. Ask an Admin to invite again.');
        }
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
        if (groups.length) {
          await tx.groupMember.createMany({ data: groups.map((g) => ({ groupId: g.id, userId: user.id, organizationId: inv.organizationId })) });
        }
        await tx.invitation.update({ where: { id: inv.id }, data: { userId: user.id } });
        await this.audit.record(
          { action: AuditAction.UserInviteAccepted, organizationId: inv.organizationId, actorId: user.id, entityType: 'user', entityId: user.id, metadata: { invitationId: inv.id, role: inv.orgRole, groupIds: groups.map((g) => g.id) }, ...meta },
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
    if (role !== 'ADMIN' && (await this.prisma.groupMember.count({ where: { userId: id } })) === 0) {
      throw new BadRequestException('Add this person to at least one group before giving them a non-Admin role');
    }
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
export function parseInviteCsv(csv: string): { row: number; email?: string; role?: string; groups?: string }[] {
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/);
  const out: { row: number; email?: string; role?: string; groups?: string }[] = [];
  let emailIdx = 0;
  let roleIdx = 1;
  let groupsIdx = -1;
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const cells = splitCsvLine(line).map((c) => c.trim());
    const lower = cells.map((c) => c.toLowerCase());
    if (i === 0 && lower.includes('email')) {
      emailIdx = lower.indexOf('email');
      roleIdx = lower.indexOf('role');
      groupsIdx = lower.indexOf('groups');
      return;
    }
    out.push({ row: i + 1, email: cells[emailIdx], role: roleIdx >= 0 ? cells[roleIdx] : undefined, groups: groupsIdx >= 0 ? (cells[groupsIdx] ?? '') : undefined });
  });
  return out;
}
