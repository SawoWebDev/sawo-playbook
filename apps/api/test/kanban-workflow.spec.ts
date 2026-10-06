/** Kanban revision state machine and approval eligibility. Pure: no database needed. */
import { canTransition, requiredPermission, blockedStage, OPEN_REVISION_STATES } from '../src/kanbans/kanban-revision';
import { eligibility } from '../src/kanbans/kanban-eligibility';
import { effectivePermissions, Permission } from '../src/common/permissions';

const actorOf = (role: 'ADMIN' | 'OPERATOR' | 'EDITOR' | 'PRE_APPROVER' | 'APPROVER', id: string, groupIds: string[]) => ({
  id,
  role,
  groupIds,
  permissions: effectivePermissions(role, null),
});

describe('revision state machine', () => {
  it('follows the normal path Draft → Pre Approved → Approved → Published', () => {
    expect(canTransition('submit', 'DRAFT')).toBe(true);
    expect(canTransition('preApprove', 'PENDING_PRE_APPROVAL')).toBe(true);
    expect(canTransition('approve', 'PRE_APPROVED')).toBe(true);
    expect(canTransition('publish', 'APPROVED')).toBe(true);
  });

  it('allows the Approver bypass: approve straight from pending, or publish directly from draft', () => {
    expect(canTransition('approve', 'PENDING_PRE_APPROVAL')).toBe(true);
    expect(canTransition('publish', 'DRAFT')).toBe(true);
  });

  it('never skips or moves backwards in a way that bypasses review', () => {
    expect(canTransition('preApprove', 'DRAFT')).toBe(false);
    expect(canTransition('submit', 'PENDING_PRE_APPROVAL')).toBe(false); // no duplicate submissions
    expect(canTransition('submit', 'PRE_APPROVED')).toBe(false);
    expect(canTransition('approve', 'DRAFT')).toBe(false); // must be submitted before it can be approved
    expect(canTransition('discard', 'PENDING_PRE_APPROVAL')).toBe(false); // in-review drafts cannot be discarded
  });

  it('terminal states accept nothing', () => {
    for (const a of ['submit', 'preApprove', 'approve', 'reject', 'publish', 'discard'] as const) {
      expect(canTransition(a, 'PUBLISHED')).toBe(false);
      expect(canTransition(a, 'DISCARDED')).toBe(false);
    }
  });

  it('a rejection returns a pending revision to DRAFT, and only from pending states', () => {
    expect(canTransition('reject', 'PENDING_PRE_APPROVAL')).toBe(true);
    expect(canTransition('reject', 'PRE_APPROVED')).toBe(true);
    expect(canTransition('reject', 'DRAFT')).toBe(false);
  });

  it('pre-approver rejects while pre-approval is pending; approver rejects later', () => {
    expect(requiredPermission('reject', 'PENDING_PRE_APPROVAL')).toBe(Permission.KanbanPreApprove);
    expect(requiredPermission('reject', 'PRE_APPROVED')).toBe(Permission.KanbanApprove);
  });

  it('exposes which stage a pending revision is blocked on', () => {
    expect(blockedStage('PENDING_PRE_APPROVAL')).toBe('pre');
    expect(blockedStage('PRE_APPROVED')).toBe('final');
    expect(blockedStage('DRAFT')).toBeNull();
  });

  it('open states are exactly the ones a live card can have a revision in', () => {
    expect(OPEN_REVISION_STATES).toEqual(['DRAFT', 'PENDING_PRE_APPROVAL', 'PRE_APPROVED', 'APPROVED']);
  });
});

describe('approval eligibility', () => {
  const base = { routingGroupIds: ['safety'], submittedById: 'editor-1', allowSelfApproval: false, isPublish: false };

  it('a role without the permission is refused, whatever the group', () => {
    const editor = actorOf('EDITOR', 'e2', ['safety']);
    expect(eligibility(editor, { ...base, permission: Permission.KanbanPreApprove })).toBe('missing_permission');
  });

  it('a Pre Approver in the routed group may pre-approve; one outside the group may not', () => {
    const inGroup = actorOf('PRE_APPROVER', 'p1', ['safety', 'ops']);
    const outside = actorOf('PRE_APPROVER', 'p2', ['hr']);
    expect(eligibility(inGroup, { ...base, permission: Permission.KanbanPreApprove })).toBeNull();
    expect(eligibility(outside, { ...base, permission: Permission.KanbanPreApprove })).toBe('outside_routing_group');
  });

  it('a multi-group submitter routes to any relevant group: a member of any one of them is eligible', () => {
    const approver = actorOf('APPROVER', 'a1', ['ops']);
    expect(eligibility(approver, { ...base, routingGroupIds: ['safety', 'ops'], permission: Permission.KanbanApprove })).toBeNull();
  });

  it('an empty routing snapshot (Admin-submitted) is organisation-wide', () => {
    const approver = actorOf('APPROVER', 'a1', []);
    expect(eligibility(approver, { ...base, routingGroupIds: [], permission: Permission.KanbanApprove })).toBeNull();
  });

  it('Admin is unrestricted by group scope', () => {
    const admin = actorOf('ADMIN', 'admin', []);
    expect(eligibility(admin, { ...base, permission: Permission.KanbanApprove })).toBeNull();
  });

  it('authority is re-checked against current groups: losing the group removes eligibility', () => {
    const before = actorOf('APPROVER', 'a1', ['safety']);
    const after = actorOf('APPROVER', 'a1', []);
    expect(eligibility(before, { ...base, permission: Permission.KanbanApprove })).toBeNull();
    expect(eligibility(after, { ...base, permission: Permission.KanbanApprove })).toBe('outside_routing_group');
  });

  it('authority is re-checked against current role: a demoted approver loses publish', () => {
    const demoted = actorOf('EDITOR', 'a1', ['safety']);
    expect(eligibility(demoted, { ...base, permission: Permission.KanbanPublish, isPublish: true })).toBe('missing_permission');
  });

  it('a submitter may not approve their own revision unless the organisation allows self-approval', () => {
    const self = actorOf('APPROVER', 'editor-1', ['safety']);
    expect(eligibility(self, { ...base, permission: Permission.KanbanApprove })).toBe('self_approval');
    expect(eligibility(self, { ...base, permission: Permission.KanbanApprove, allowSelfApproval: true })).toBeNull();
  });

  it('publishing is not blocked by the self-approval rule (direct publish)', () => {
    const self = actorOf('APPROVER', 'editor-1', ['safety']);
    expect(eligibility(self, { ...base, permission: Permission.KanbanPublish, isPublish: true })).toBeNull();
  });
});
