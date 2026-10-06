/** SOP Approver bypass of pre-approval, and quorum of three distinct final approvals with progress reporting. */
import { MailService } from '../src/mail/mail.service';
import { createTenant, createTestApp, refreshAuth, resetDatabase, Tenant, TestContext } from './harness';
import { sopHelpers } from './sop-helpers';

let ctx: TestContext;
const h = sopHelpers(() => ctx);
const as = h.as;
const STEPS = [{ description: 'Check the seal' }];

beforeAll(async () => {
  ctx = await createTestApp();
  await resetDatabase(ctx.prisma);
});
afterAll(() => ctx.close());

/** Approval required, default quorum (3), and three working Approvers in the General group. */
async function tenant(label: string) {
  const t = await createTenant(ctx, label);
  await ctx.prisma.organizationSettings.update({ where: { organizationId: t.organizationId }, data: { approvalRequired: true } });
  const third = await t.addUser('APPROVER', 'third-approver');
  return { t, approvers: [t.users.APPROVER, t.reviewer, third] as const };
}

async function submitted(t: Tenant, name = 'Bypass SOP') {
  const { sopId, versionId } = await h.createSop(t, name);
  await h.saveSteps(t, sopId, versionId, STEPS);
  await ctx.http().post(`/api/sops/${sopId}/versions/${versionId}/submit`).set(as(t, 'EDITOR')).send({}).expect(200);
  return { sopId, versionId };
}

const url = (sopId: string, versionId: string) => `/api/sops/${sopId}/versions/${versionId}`;
const stateOf = async (versionId: string) => (await ctx.prisma.sopVersion.findUniqueOrThrow({ where: { id: versionId } })).lifecycleState;
const detail = async (t: Tenant, sopId: string, versionId: string, who: { auth: { Authorization: string } } | Tenant = t) =>
  ctx.http().get(`${url(sopId, versionId)}/approvals`).set('auth' in who ? who.auth : as(t, 'OPERATOR')).expect(200);

describe('Approver bypass of pre-approval', () => {
  it('an eligible Approver can approve while pre-approval is pending; the pre stage is skipped and the vote counts as one final approval', async () => {
    const { t, approvers } = await tenant('bypass-ok');
    const { sopId, versionId } = await submitted(t);
    const r = await ctx.http().post(`${url(sopId, versionId)}/decisions`).set(approvers[0].auth).send({ decision: 'approved' }).expect(200);
    expect(r.body.lifecycleState).toBe('PENDING_APPROVAL'); // quorum of three still applies
    const d = await detail(t, sopId, versionId, approvers[0]);
    expect(d.body).toMatchObject({ preApprovalSkipped: true, preApprovalSkippedBy: approvers[0].user.id, quorum: { required: 3, current: 1, remaining: 2 } });
  });

  it('the bypass creates no fake pre-approval record: only a final-stage approval is stored', async () => {
    const { t, approvers } = await tenant('bypass-no-fake');
    const { sopId, versionId } = await submitted(t);
    await ctx.http().post(`${url(sopId, versionId)}/decisions`).set(approvers[0].auth).send({ decision: 'approved' }).expect(200);
    const rows = await ctx.prisma.sopVersionApproval.findMany({ where: { sopVersionId: versionId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stage: 'final', decision: 'approved', approverId: approvers[0].user.id });
    expect(rows.some((r) => r.stage === 'pre')).toBe(false);
  });

  it('the audit trail records the skipped pre-approval with its actor, and the approval marks the bypass', async () => {
    const { t, approvers } = await tenant('bypass-audit');
    const { sopId, versionId } = await submitted(t);
    await ctx.http().post(`${url(sopId, versionId)}/decisions`).set(approvers[0].auth).send({ decision: 'approved' }).expect(200);
    const skipped = await ctx.prisma.auditLog.findFirstOrThrow({ where: { organizationId: t.organizationId, entityId: versionId, action: 'sop.version.pre_approval_skipped' } });
    expect(skipped.actorId).toBe(approvers[0].user.id);
    expect(skipped.metadata).toMatchObject({ reason: 'approver_bypass', skippedBy: approvers[0].user.id, previousState: 'PENDING_PRE_APPROVAL', newState: 'PENDING_APPROVAL' });
    const approved = await ctx.prisma.auditLog.findFirstOrThrow({ where: { organizationId: t.organizationId, entityId: versionId, action: 'sop.version.approved' } });
    expect(approved.metadata).toMatchObject({ stage: 'final', bypassedPreApproval: true, previousState: 'PENDING_PRE_APPROVAL' });
  });

  it('unauthorised roles cannot bypass: Editor, Viewer and Pre Approver are refused and nothing changes', async () => {
    const { t } = await tenant('bypass-refused');
    const { sopId, versionId } = await submitted(t);
    await ctx.http().post(`${url(sopId, versionId)}/decisions`).set(as(t, 'EDITOR')).send({ decision: 'approved' }).expect(403);
    await ctx.http().post(`${url(sopId, versionId)}/decisions`).set(as(t, 'OPERATOR')).send({ decision: 'approved' }).expect(403);
    await ctx.http().post(`${url(sopId, versionId)}/decisions`).set(as(t, 'PRE_APPROVER')).send({ decision: 'approved' }).expect(403);
    expect(await stateOf(versionId)).toBe('PENDING_PRE_APPROVAL');
    expect(await ctx.prisma.auditLog.count({ where: { entityId: versionId, action: 'sop.version.pre_approval_skipped' } })).toBe(0);
  });

  it('self-approval still applies to the bypass: the submitter cannot bypass their own submission', async () => {
    const { t } = await tenant('bypass-self');
    const { sopId, versionId } = await h.createSop(t, 'Self bypass');
    await h.saveSteps(t, sopId, versionId, STEPS);
    await ctx.http().post(`${url(sopId, versionId)}/submit`).set(as(t, 'ADMIN')).send({}).expect(200);
    await ctx.http().post(`${url(sopId, versionId)}/decisions`).set(as(t, 'ADMIN')).send({ decision: 'approved' }).expect(403);
    expect(await stateOf(versionId)).toBe('PENDING_PRE_APPROVAL');
  });

  it('group eligibility is enforced for the bypass: an Approver outside the routed group is refused', async () => {
    const { t, approvers } = await tenant('bypass-group');
    const outsider = approvers[2];
    const hr = await ctx.prisma.userGroup.create({ data: { organizationId: t.organizationId, name: 'HR' } });
    await ctx.prisma.groupMember.deleteMany({ where: { userId: outsider.user.id } });
    await ctx.prisma.groupMember.create({ data: { groupId: hr.id, userId: outsider.user.id, organizationId: t.organizationId } });
    const { sopId, versionId } = await submitted(t);
    await ctx.http().post(`${url(sopId, versionId)}/decisions`).set(outsider.auth).send({ decision: 'approved' }).expect(403);
    expect(await stateOf(versionId)).toBe('PENDING_PRE_APPROVAL');
  });

  it('a suspended Approver cannot bypass', async () => {
    const { t, approvers } = await tenant('bypass-suspended');
    const { sopId, versionId } = await submitted(t);
    await ctx.prisma.user.update({ where: { id: approvers[0].user.id }, data: { status: 'suspended' } });
    await ctx.http().post(`${url(sopId, versionId)}/decisions`).set(approvers[0].auth).send({ decision: 'approved' }).expect(401);
    expect(await stateOf(versionId)).toBe('PENDING_PRE_APPROVAL');
  });

  it('the bypass never publishes: Editor, Pre Approver and an Approver before APPROVED are all refused', async () => {
    const { t, approvers } = await tenant('bypass-no-publish');
    const { sopId, versionId } = await submitted(t);
    await ctx.http().post(`${url(sopId, versionId)}/decisions`).set(approvers[0].auth).send({ decision: 'approved' }).expect(200);
    await ctx.http().post(`${url(sopId, versionId)}/publish`).set(as(t, 'EDITOR')).send({}).expect(403);
    await ctx.http().post(`${url(sopId, versionId)}/publish`).set(as(t, 'PRE_APPROVER')).send({}).expect(403);
    await ctx.http().post(`${url(sopId, versionId)}/publish`).set(approvers[0].auth).send({}).expect(409); // not yet APPROVED
    expect((await ctx.prisma.sop.findUniqueOrThrow({ where: { id: sopId } })).currentPublishedVersionId).toBeNull();
  });

  it('the normal path still works: Pre Approver first, then the final approvals', async () => {
    const { t, approvers } = await tenant('bypass-normal');
    const { sopId, versionId } = await submitted(t);
    await ctx.http().post(`${url(sopId, versionId)}/pre-approve`).set(as(t, 'PRE_APPROVER')).send({}).expect(200);
    const d = await detail(t, sopId, versionId, approvers[0]);
    expect(d.body.preApprovalSkipped).toBe(false);
    expect(await ctx.prisma.auditLog.count({ where: { entityId: versionId, action: 'sop.version.pre_approval_skipped' } })).toBe(0);
    expect(await stateOf(versionId)).toBe('PENDING_APPROVAL');
  });
});

describe('quorum of three distinct final approvals', () => {
  it('three distinct final approvals are required; the version is approved only on the third', async () => {
    const { t, approvers } = await tenant('quorum-three');
    const { sopId, versionId } = await submitted(t);
    await ctx.http().post(`${url(sopId, versionId)}/pre-approve`).set(as(t, 'PRE_APPROVER')).send({}).expect(200);
    await ctx.http().post(`${url(sopId, versionId)}/decisions`).set(approvers[0].auth).send({ decision: 'approved' }).expect(200);
    await ctx.http().post(`${url(sopId, versionId)}/decisions`).set(approvers[1].auth).send({ decision: 'approved' }).expect(200);
    expect(await stateOf(versionId)).toBe('PENDING_APPROVAL');
    await ctx.http().post(`${url(sopId, versionId)}/decisions`).set(approvers[2].auth).send({ decision: 'approved' }).expect(200);
    expect(await stateOf(versionId)).toBe('APPROVED');
  });

  it('a duplicate approval by the same person cannot count twice', async () => {
    const { t, approvers } = await tenant('quorum-dup');
    const { sopId, versionId } = await submitted(t);
    await ctx.http().post(`${url(sopId, versionId)}/pre-approve`).set(as(t, 'PRE_APPROVER')).send({}).expect(200);
    await ctx.http().post(`${url(sopId, versionId)}/decisions`).set(approvers[0].auth).send({ decision: 'approved' }).expect(200);
    await ctx.http().post(`${url(sopId, versionId)}/decisions`).set(approvers[0].auth).send({ decision: 'approved' }).expect(409);
    const d = await detail(t, sopId, versionId, approvers[1]);
    expect(d.body.quorum).toMatchObject({ current: 1, remaining: 2 });
    expect(await stateOf(versionId)).toBe('PENDING_APPROVAL');
  });

  it('quorum progress is returned for the UI: required, current, remaining, eligible count, and the caller\'s own position', async () => {
    const { t, approvers } = await tenant('quorum-fields');
    const { sopId, versionId } = await submitted(t);
    await ctx.http().post(`${url(sopId, versionId)}/pre-approve`).set(as(t, 'PRE_APPROVER')).send({}).expect(200);
    await ctx.http().post(`${url(sopId, versionId)}/decisions`).set(approvers[0].auth).send({ decision: 'approved' }).expect(200);

    const mine = await detail(t, sopId, versionId, approvers[0]);
    expect(mine.body.quorum).toEqual({
      required: 3,
      current: 1,
      remaining: 2,
      eligibleApproverCount: 3,
      availableApproverCount: 2,
      currentUserApproved: true,
      currentUserCanApprove: false,
      stage: 'final',
    });
    const other = await detail(t, sopId, versionId, approvers[1]);
    expect(other.body.quorum).toMatchObject({ currentUserApproved: false, currentUserCanApprove: true });
  });

  it('when eligible approvers cannot reach quorum the version is blocked, Admins are notified once, and it is actionable again when one returns', async () => {
    const { t, approvers } = await tenant('quorum-blocked');
    await ctx.prisma.user.update({ where: { id: approvers[0].user.id }, data: { status: 'suspended' } });
    await ctx.prisma.user.update({ where: { id: approvers[1].user.id }, data: { status: 'suspended' } });
    const { sopId, versionId } = await submitted(t);
    await ctx.http().post(`${url(sopId, versionId)}/pre-approve`).set(as(t, 'PRE_APPROVER')).send({}).expect(200);
    const d = await detail(t, sopId, versionId, approvers[2]);
    expect(d.body.blocked).toBe(true);
    expect(d.body.blockedReason).toMatch(/quorum|approver/i);
    const mail = ctx.app.get(MailService).outbox.filter((m) => m.to === t.users.ADMIN.user.email && /Approval blocked/.test(m.subject));
    expect(mail).toHaveLength(1);
    expect(await ctx.prisma.auditLog.count({ where: { entityId: versionId, action: 'sop.version.blocked' } })).toBe(1);

    // an approver returns: no resubmission needed, and the item is actionable
    await ctx.prisma.user.update({ where: { id: approvers[0].user.id }, data: { status: 'active' } });
    const back = await refreshAuth(ctx, approvers[0]);
    const inbox = await ctx.http().get('/api/sops/approvals').set(back.auth).expect(200);
    expect(inbox.body.finalApproval.map((i: { versionId: string }) => i.versionId)).toContain(versionId);
    await ctx.http().post(`${url(sopId, versionId)}/decisions`).set(back.auth).send({ decision: 'approved' }).expect(200);
  });
});
