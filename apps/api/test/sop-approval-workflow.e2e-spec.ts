/** SOP approval workflow: submission, group routing, pre-approval, final approval, blocked state, rejection, notifications, audit, inbox. */
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

/** A tenant with quorum 1 so one final approval completes the flow; approval is required. */
async function tenant(label: string) {
  const t = await createTenant(ctx, label);
  await ctx.prisma.organizationSettings.update({ where: { organizationId: t.organizationId }, data: { approvalRequired: true, approvalQuorum: 1 } });
  return t;
}

async function draft(t: Tenant, name = 'Workflow SOP') {
  const { sopId, versionId } = await h.createSop(t, name);
  await h.saveSteps(t, sopId, versionId, STEPS);
  return { sopId, versionId };
}

const url = (sopId: string, versionId: string) => `/api/sops/${sopId}/versions/${versionId}`;
const groupOf = (t: Tenant, name = 'General') => ctx.prisma.userGroup.findFirstOrThrow({ where: { organizationId: t.organizationId, name } });
const stateOf = async (versionId: string) => (await ctx.prisma.sopVersion.findUniqueOrThrow({ where: { id: versionId } })).lifecycleState;
const mailTo = (email: string, subjectPart: string) => ctx.app.get(MailService).outbox.filter((m) => m.to === email && m.subject.includes(subjectPart));

describe('submission', () => {
  it('an Editor can submit a draft; the version moves to pre-approval', async () => {
    const t = await tenant('wf-submit');
    const { sopId, versionId } = await draft(t);
    const r = await ctx.http().post(`${url(sopId, versionId)}/submit`).set(as(t, 'EDITOR')).send({}).expect(200);
    expect(r.body.lifecycleState).toBe('PENDING_PRE_APPROVAL');
  });

  it('a Viewer cannot submit (403); a Pre Approver cannot submit by default (403)', async () => {
    const t = await tenant('wf-submit-refused');
    const { sopId, versionId } = await draft(t);
    await ctx.http().post(`${url(sopId, versionId)}/submit`).set(as(t, 'OPERATOR')).send({}).expect(403);
    await ctx.http().post(`${url(sopId, versionId)}/submit`).set(as(t, 'PRE_APPROVER')).send({}).expect(403);
    expect(await stateOf(versionId)).toBe('DRAFT');
  });

  it('a submitted revision is immutable while pending: steps and details cannot change', async () => {
    const t = await tenant('wf-immutable');
    const { sopId, versionId } = await draft(t);
    await ctx.http().post(`${url(sopId, versionId)}/submit`).set(as(t, 'EDITOR')).send({}).expect(200);
    await ctx.http().put(`${url(sopId, versionId)}/steps`).set(as(t, 'EDITOR')).send({ steps: [{ description: 'sneaky' }] }).expect(409);
    await ctx.http().patch(url(sopId, versionId)).set(as(t, 'EDITOR')).send({ changeSummary: 'x' }).expect(409);
  });
});

describe('group routing', () => {
  it('the submitter\'s groups are snapshotted onto the version, and multiple groups are all recorded', async () => {
    const t = await tenant('wf-routing');
    const general = await groupOf(t);
    const ops = await ctx.prisma.userGroup.create({ data: { organizationId: t.organizationId, name: 'Ops' } });
    await ctx.prisma.groupMember.create({ data: { groupId: ops.id, userId: t.users.EDITOR.user.id, organizationId: t.organizationId } });
    const { sopId, versionId } = await draft(t);
    await ctx.http().post(`${url(sopId, versionId)}/submit`).set(as(t, 'EDITOR')).send({}).expect(200);
    const v = await ctx.prisma.sopVersion.findUniqueOrThrow({ where: { id: versionId } });
    expect([...v.routingGroupIds].sort()).toEqual([general.id, ops.id].sort());
  });

  it('changing the submitter\'s groups afterwards does not rewrite the snapshot', async () => {
    const t = await tenant('wf-snapshot');
    const general = await groupOf(t);
    const { sopId, versionId } = await draft(t);
    await ctx.http().post(`${url(sopId, versionId)}/submit`).set(as(t, 'EDITOR')).send({}).expect(200);
    await ctx.prisma.groupMember.deleteMany({ where: { userId: t.users.EDITOR.user.id } });
    const v = await ctx.prisma.sopVersion.findUniqueOrThrow({ where: { id: versionId } });
    expect(v.routingGroupIds).toEqual([general.id]);
  });

  it('an approver outside the routed group cannot pre-approve; the item does not appear in their inbox', async () => {
    const t = await tenant('wf-unrelated');
    const outsider = await t.addUser('PRE_APPROVER', 'outsider');
    const hr = await ctx.prisma.userGroup.create({ data: { organizationId: t.organizationId, name: 'HR' } });
    await ctx.prisma.groupMember.deleteMany({ where: { userId: outsider.user.id } });
    await ctx.prisma.groupMember.create({ data: { groupId: hr.id, userId: outsider.user.id, organizationId: t.organizationId } });
    const { sopId, versionId } = await draft(t);
    await ctx.http().post(`${url(sopId, versionId)}/submit`).set(as(t, 'EDITOR')).send({}).expect(200);
    await ctx.http().post(`${url(sopId, versionId)}/pre-approve`).set(outsider.auth).send({}).expect(403);
    const inbox = await ctx.http().get('/api/sops/approvals').set(outsider.auth).expect(200);
    expect(inbox.body.preApproval.map((i: { versionId: string }) => i.versionId)).not.toContain(versionId);
  });

  it('a pre-approver who shares one of several routed groups can act', async () => {
    const t = await tenant('wf-multi');
    const ops = await ctx.prisma.userGroup.create({ data: { organizationId: t.organizationId, name: 'Ops' } });
    await ctx.prisma.groupMember.create({ data: { groupId: ops.id, userId: t.users.EDITOR.user.id, organizationId: t.organizationId } });
    const opsPre = await t.addUser('PRE_APPROVER', 'ops-pre');
    await ctx.prisma.groupMember.deleteMany({ where: { userId: opsPre.user.id } });
    await ctx.prisma.groupMember.create({ data: { groupId: ops.id, userId: opsPre.user.id, organizationId: t.organizationId } });
    const { sopId, versionId } = await draft(t);
    await ctx.http().post(`${url(sopId, versionId)}/submit`).set(as(t, 'EDITOR')).send({}).expect(200);
    await ctx.http().post(`${url(sopId, versionId)}/pre-approve`).set(opsPre.auth).send({}).expect(200);
  });
});

describe('pre-approval and final approval', () => {
  it('an eligible Pre Approver can pre-approve; they cannot publish or give the final decision', async () => {
    const t = await tenant('wf-pre');
    const { sopId, versionId } = await draft(t);
    await ctx.http().post(`${url(sopId, versionId)}/submit`).set(as(t, 'EDITOR')).send({}).expect(200);
    await ctx.http().post(`${url(sopId, versionId)}/publish`).set(as(t, 'PRE_APPROVER')).send({}).expect(403);
    await ctx.http().post(`${url(sopId, versionId)}/decisions`).set(as(t, 'PRE_APPROVER')).send({ decision: 'approved' }).expect(403);
    const r = await ctx.http().post(`${url(sopId, versionId)}/pre-approve`).set(as(t, 'PRE_APPROVER')).send({}).expect(200);
    expect(r.body.lifecycleState).toBe('PENDING_APPROVAL');
  });

  it('an eligible Pre Approver can reject with a comment; the version returns to DRAFT', async () => {
    const t = await tenant('wf-pre-reject');
    const { sopId, versionId } = await draft(t);
    await ctx.http().post(`${url(sopId, versionId)}/submit`).set(as(t, 'EDITOR')).send({}).expect(200);
    await ctx.http().post(`${url(sopId, versionId)}/reject`).set(as(t, 'PRE_APPROVER')).send({ comment: '' }).expect(400);
    const r = await ctx.http().post(`${url(sopId, versionId)}/reject`).set(as(t, 'PRE_APPROVER')).send({ comment: 'Missing PPE step' }).expect(200);
    expect(r.body.lifecycleState).toBe('DRAFT');
  });

  it('an Editor cannot pre-approve, approve or publish (403)', async () => {
    const t = await tenant('wf-editor-refused');
    const { sopId, versionId } = await draft(t);
    await ctx.http().post(`${url(sopId, versionId)}/submit`).set(as(t, 'EDITOR')).send({}).expect(200);
    await ctx.http().post(`${url(sopId, versionId)}/pre-approve`).set(as(t, 'EDITOR')).send({}).expect(403);
    await ctx.http().post(`${url(sopId, versionId)}/decisions`).set(as(t, 'EDITOR')).send({ decision: 'approved' }).expect(403);
    await ctx.http().post(`${url(sopId, versionId)}/publish`).set(as(t, 'EDITOR')).send({}).expect(403);
  });

  it('an eligible Approver approves after pre-approval and publishes (the Approver bypass is covered in sop-bypass-quorum)', async () => {
    const t = await tenant('wf-final');
    const { sopId, versionId } = await draft(t);
    await ctx.http().post(`${url(sopId, versionId)}/submit`).set(as(t, 'EDITOR')).send({}).expect(200);
    await ctx.http().post(`${url(sopId, versionId)}/pre-approve`).set(as(t, 'PRE_APPROVER')).send({}).expect(200);
    await ctx.http().post(`${url(sopId, versionId)}/decisions`).set(as(t, 'APPROVER')).send({ decision: 'approved' }).expect(200);
    expect(await stateOf(versionId)).toBe('APPROVED');
    await ctx.http().post(`${url(sopId, versionId)}/publish`).set(as(t, 'APPROVER')).send({}).expect(200);
    expect((await ctx.prisma.sop.findUniqueOrThrow({ where: { id: sopId } })).currentPublishedVersionId).toBe(versionId);
  });

  it('a lost group membership stops an approver acting at the moment they try', async () => {
    const t = await tenant('wf-lost-group');
    const { sopId, versionId } = await draft(t);
    await ctx.http().post(`${url(sopId, versionId)}/submit`).set(as(t, 'EDITOR')).send({}).expect(200);
    await ctx.prisma.groupMember.deleteMany({ where: { userId: t.users.PRE_APPROVER.user.id } });
    await ctx.http().post(`${url(sopId, versionId)}/pre-approve`).set(as(t, 'PRE_APPROVER')).send({}).expect(403);
    expect(await stateOf(versionId)).toBe('PENDING_PRE_APPROVAL');
  });

  it('a lost permission stops an approver acting, and a suspended user cannot act at all', async () => {
    const t = await tenant('wf-lost-perm');
    const pre = await t.addUser('PRE_APPROVER', 'lost-perm');
    const { sopId, versionId } = await draft(t);
    await ctx.http().post(`${url(sopId, versionId)}/submit`).set(as(t, 'EDITOR')).send({}).expect(200);
    await ctx.http().patch(`/api/users/${pre.user.id}/role`).set(as(t, 'OWNER')).send({ role: 'OPERATOR' }).expect(200);
    // the role change revoked the old session (401); signing in again must show the lost permission (403)
    const demoted = await refreshAuth(ctx, pre);
    await ctx.http().post(`${url(sopId, versionId)}/pre-approve`).set(demoted.auth).send({}).expect(403);

    const suspended = await t.addUser('PRE_APPROVER', 'suspended');
    await ctx.prisma.groupMember.deleteMany({ where: { userId: suspended.user.id } });
    await ctx.prisma.groupMember.create({ data: { groupId: (await groupOf(t)).id, userId: suspended.user.id, organizationId: t.organizationId } });
    await ctx.prisma.user.update({ where: { id: suspended.user.id }, data: { status: 'suspended' } });
    await ctx.http().post(`${url(sopId, versionId)}/pre-approve`).set(suspended.auth).send({}).expect(401);
  });

  it('Admin override: an Admin outside the routed group can pre-approve', async () => {
    const t = await tenant('wf-admin');
    const { sopId, versionId } = await draft(t);
    await ctx.http().post(`${url(sopId, versionId)}/submit`).set(as(t, 'EDITOR')).send({}).expect(200);
    await ctx.http().post(`${url(sopId, versionId)}/pre-approve`).set(as(t, 'ADMIN')).send({}).expect(200);
  });
});

describe('blocked approval', () => {
  it('with no eligible Pre Approver the version is blocked, Admins are notified once, and the inbox shows it', async () => {
    const t = await tenant('wf-blocked');
    await ctx.prisma.user.update({ where: { id: t.users.PRE_APPROVER.user.id }, data: { status: 'suspended' } });
    const { sopId, versionId } = await draft(t, 'Blocked SOP');
    await ctx.http().post(`${url(sopId, versionId)}/submit`).set(as(t, 'EDITOR')).send({}).expect(200);
    expect(await stateOf(versionId)).toBe('PENDING_PRE_APPROVAL'); // not bypassed

    const first = await ctx.http().get('/api/sops/approvals').set(as(t, 'ADMIN')).expect(200);
    expect(first.body.blocked.map((i: { versionId: string }) => i.versionId)).toContain(versionId);
    expect(first.body.blocked.find((i: { versionId: string }) => i.versionId === versionId).blockedReason).toMatch(/no eligible Pre Approver/);

    // repeated reads and repeated processing must not duplicate the notification
    await ctx.http().get('/api/sops/approvals').set(as(t, 'ADMIN')).expect(200);
    await ctx.http().post(`${url(sopId, versionId)}/submit`).set(as(t, 'EDITOR')).send({}).expect(409);
    expect(mailTo(t.users.ADMIN.user.email, 'Approval blocked')).toHaveLength(1);
    expect(await ctx.prisma.auditLog.count({ where: { organizationId: t.organizationId, action: 'sop.version.blocked', entityId: versionId } })).toBe(1);
  });

  it('when an eligible Pre Approver appears later, the same version becomes actionable without resubmission', async () => {
    const t = await tenant('wf-unblock');
    await ctx.prisma.user.update({ where: { id: t.users.PRE_APPROVER.user.id }, data: { status: 'suspended' } });
    const { sopId, versionId } = await draft(t);
    await ctx.http().post(`${url(sopId, versionId)}/submit`).set(as(t, 'EDITOR')).send({}).expect(200);
    const later = await t.addUser('PRE_APPROVER', 'later-pre');
    const inbox = await ctx.http().get('/api/sops/approvals').set(later.auth).expect(200);
    expect(inbox.body.preApproval.map((i: { versionId: string }) => i.versionId)).toContain(versionId);
    await ctx.http().post(`${url(sopId, versionId)}/pre-approve`).set(later.auth).send({}).expect(200);
  });
});

describe('rejection and resubmission', () => {
  it('after rejection the submitter can edit, resubmit with a fresh round and new routing, and old decisions do not count', async () => {
    const t = await tenant('wf-resubmit');
    const { sopId, versionId } = await draft(t);
    await ctx.http().post(`${url(sopId, versionId)}/submit`).set(as(t, 'EDITOR')).send({}).expect(200);
    await ctx.http().post(`${url(sopId, versionId)}/pre-approve`).set(as(t, 'PRE_APPROVER')).send({}).expect(200);
    await ctx.http().post(`${url(sopId, versionId)}/reject`).set(as(t, 'APPROVER')).send({ comment: 'Wrong order' }).expect(200);
    expect(await stateOf(versionId)).toBe('DRAFT');
    await h.saveSteps(t, sopId, versionId, [{ description: 'Corrected order' }]);

    // the submitter moves to another group before resubmitting: the new snapshot follows the current groups
    const ops = await ctx.prisma.userGroup.create({ data: { organizationId: t.organizationId, name: 'Ops' } });
    await ctx.prisma.groupMember.create({ data: { groupId: ops.id, userId: t.users.EDITOR.user.id, organizationId: t.organizationId } });
    const resub = await ctx.http().post(`${url(sopId, versionId)}/submit`).set(as(t, 'EDITOR')).send({}).expect(200);
    expect(resub.body.currentApprovalRound).toBe(2);
    const v = await ctx.prisma.sopVersion.findUniqueOrThrow({ where: { id: versionId } });
    expect(v.routingGroupIds).toContain(ops.id);

    // the earlier pre-approval belongs to round 1 and does not satisfy round 2
    const hist = await ctx.http().get(`${url(sopId, versionId)}/approvals`).set(as(t, 'EDITOR')).expect(200);
    expect(hist.body.decisions.filter((d: { round: number; stage: string }) => d.round === 2)).toHaveLength(0);
    expect(hist.body.lifecycleState).toBe('PENDING_PRE_APPROVAL');
  });
});

describe('notifications, audit and inbox', () => {
  it('submission, pre-approval, rejection and final approval each notify the right people once', async () => {
    const t = await tenant('wf-notify');
    const { sopId, versionId } = await draft(t, 'Notify SOP');
    await ctx.http().post(`${url(sopId, versionId)}/submit`).set(as(t, 'EDITOR')).send({}).expect(200);
    expect(mailTo(t.users.PRE_APPROVER.user.email, 'requires your pre-approval')).toHaveLength(1);
    await ctx.http().post(`${url(sopId, versionId)}/pre-approve`).set(as(t, 'PRE_APPROVER')).send({}).expect(200);
    expect(mailTo(t.users.APPROVER.user.email, 'passed pre-approval')).toHaveLength(1);
    await ctx.http().post(`${url(sopId, versionId)}/decisions`).set(as(t, 'APPROVER')).send({ decision: 'approved' }).expect(200);
    expect(mailTo(t.users.EDITOR.user.email, 'approved')).toHaveLength(1);
  });

  it('rejection notifies the submitter with the reason', async () => {
    const t = await tenant('wf-notify-reject');
    const { sopId, versionId } = await draft(t);
    await ctx.http().post(`${url(sopId, versionId)}/submit`).set(as(t, 'EDITOR')).send({}).expect(200);
    await ctx.http().post(`${url(sopId, versionId)}/reject`).set(as(t, 'PRE_APPROVER')).send({ comment: 'Needs a photo' }).expect(200);
    const sent = mailTo(t.users.EDITOR.user.email, 'rejected');
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('Needs a photo');
  });

  it('every workflow transition is audited with actor, state change, stage and routing', async () => {
    const t = await tenant('wf-audit');
    const { sopId, versionId } = await draft(t);
    await ctx.http().post(`${url(sopId, versionId)}/submit`).set(as(t, 'EDITOR')).send({}).expect(200);
    await ctx.http().post(`${url(sopId, versionId)}/pre-approve`).set(as(t, 'PRE_APPROVER')).send({}).expect(200);
    await ctx.http().post(`${url(sopId, versionId)}/decisions`).set(as(t, 'APPROVER')).send({ decision: 'approved' }).expect(200);
    await ctx.http().post(`${url(sopId, versionId)}/publish`).set(as(t, 'APPROVER')).send({}).expect(200);
    const rows = await ctx.prisma.auditLog.findMany({ where: { organizationId: t.organizationId, entityId: versionId }, orderBy: { occurredAt: 'asc' } });
    expect(rows.map((r) => r.action)).toEqual(['sop.version.submitted', 'sop.version.pre_approved', 'sop.version.approved', 'sop.version.published']);
    expect(rows[1].actorId).toBe(t.users.PRE_APPROVER.user.id);
    expect(rows[1].metadata).toMatchObject({ stage: 'pre', previousState: 'PENDING_PRE_APPROVAL', newState: 'PENDING_APPROVAL' });
    expect(rows[0].metadata).toMatchObject({ previousState: 'DRAFT', newState: 'PENDING_PRE_APPROVAL', stage: 'pre' });
  });

  it('the inbox lists what each person can act on, and the submitter sees their own item and its status', async () => {
    const t = await tenant('wf-inbox');
    const { sopId, versionId } = await draft(t, 'Inbox SOP');
    await ctx.http().post(`${url(sopId, versionId)}/submit`).set(as(t, 'EDITOR')).send({}).expect(200);
    const pre = await ctx.http().get('/api/sops/approvals').set(as(t, 'PRE_APPROVER')).expect(200);
    const item = pre.body.preApproval.find((i: { versionId: string }) => i.versionId === versionId);
    expect(item).toMatchObject({ name: 'Inbox SOP', state: 'PENDING_PRE_APPROVAL', stage: 'pre', actions: { preApprove: true, reject: true, approve: false } });
    expect(item.submitter.id).toBe(t.users.EDITOR.user.id);
    expect(item.routingGroups.map((g: { name: string }) => g.name)).toEqual(['General']);
    const mine = await ctx.http().get('/api/sops/approvals').set(as(t, 'EDITOR')).expect(200);
    expect(mine.body.mine.map((i: { versionId: string }) => i.versionId)).toContain(versionId);
    expect(mine.body.preApproval).toEqual([]); // an Editor has no pre-approval actions
  });

  it('the detail endpoint reports stage, routing, blocked state and the actions for the caller', async () => {
    const t = await tenant('wf-detail');
    const { sopId, versionId } = await draft(t);
    await ctx.http().post(`${url(sopId, versionId)}/submit`).set(as(t, 'EDITOR')).send({}).expect(200);
    const d = await ctx.http().get(`${url(sopId, versionId)}/approvals`).set(as(t, 'OPERATOR')).expect(200);
    expect(d.body).toMatchObject({ stage: 'pre', blocked: false, actions: { preApprove: false, approve: false, reject: false, publish: false } });
    expect(d.body.routingGroups.map((g: { name: string }) => g.name)).toEqual(['General']);
  });

  it('an organisation cannot see another organisation\'s SOP approvals', async () => {
    const t1 = await tenant('wf-iso-a');
    const t2 = await tenant('wf-iso-b');
    const { sopId, versionId } = await draft(t1);
    await ctx.http().post(`${url(sopId, versionId)}/submit`).set(as(t1, 'EDITOR')).send({}).expect(200);
    await ctx.http().get(`${url(sopId, versionId)}/approvals`).set(as(t2, 'PRE_APPROVER')).expect(404);
    const inbox = await ctx.http().get('/api/sops/approvals').set(as(t2, 'PRE_APPROVER')).expect(200);
    expect(JSON.stringify(inbox.body)).not.toContain(versionId);
  });
});
