import { ConflictException } from '@nestjs/common';
import { KanbanRevisionState } from '@prisma/client';
import { Permission } from '../common/permissions';

/**
 * Kanban revision lifecycle (pure, so it is unit-testable):
 *
 *   DRAFT ──submit──▶ PENDING_PRE_APPROVAL ──pre-approve──▶ PRE_APPROVED ──approve──▶ APPROVED ──publish──▶ PUBLISHED
 *     ▲                     │  │                                 │  │                    │
 *     │                     │  └──────────approve (bypass)───────┘  │                    │
 *     └──────reject─────────┘                                       └──reject──▶ DRAFT ◀─┘
 *
 *   • publish is also allowed directly from DRAFT / PENDING / PRE_APPROVED / APPROVED by a publisher (direct publish).
 *   • DRAFT can be discarded; PUBLISHED / DISCARDED are terminal.
 *   • The live kanban row changes only on PUBLISHED.
 */
export const OPEN_REVISION_STATES: KanbanRevisionState[] = ['DRAFT', 'PENDING_PRE_APPROVAL', 'PRE_APPROVED', 'APPROVED'];
export const PENDING_REVISION_STATES: KanbanRevisionState[] = ['PENDING_PRE_APPROVAL', 'PRE_APPROVED', 'APPROVED'];

export type RevisionAction = 'submit' | 'preApprove' | 'approve' | 'reject' | 'publish' | 'discard';

/** Legal source states per action. Anything else is a 409 (no skipping or moving backwards). */
const FROM: Record<RevisionAction, KanbanRevisionState[]> = {
  submit: ['DRAFT'],
  preApprove: ['PENDING_PRE_APPROVAL'],
  approve: ['PENDING_PRE_APPROVAL', 'PRE_APPROVED'],
  reject: ['PENDING_PRE_APPROVAL', 'PRE_APPROVED', 'APPROVED'],
  publish: ['DRAFT', 'PENDING_PRE_APPROVAL', 'PRE_APPROVED', 'APPROVED'],
  discard: ['DRAFT'],
};

const TO: Record<RevisionAction, KanbanRevisionState> = {
  submit: 'PENDING_PRE_APPROVAL',
  preApprove: 'PRE_APPROVED',
  approve: 'APPROVED',
  reject: 'DRAFT',
  publish: 'PUBLISHED',
  discard: 'DISCARDED',
};

export function sourceStates(action: RevisionAction): KanbanRevisionState[] {
  return FROM[action];
}

export function targetState(action: RevisionAction): KanbanRevisionState {
  return TO[action];
}

export function canTransition(action: RevisionAction, from: KanbanRevisionState): boolean {
  return FROM[action].includes(from);
}

/** The permission that authorises an action, given the revision's current state. Pure. */
export function requiredPermission(action: RevisionAction, state: KanbanRevisionState): Permission {
  switch (action) {
    case 'submit':
      return Permission.KanbanSubmit;
    case 'preApprove':
      return Permission.KanbanPreApprove;
    case 'approve':
      return Permission.KanbanApprove;
    case 'publish':
      return Permission.KanbanPublish;
    case 'discard':
      return Permission.KanbanEdit;
    case 'reject':
      // A pre-approver may reject a submission awaiting pre-approval; anything further along needs final approval rights.
      return state === 'PENDING_PRE_APPROVAL' ? Permission.KanbanPreApprove : Permission.KanbanApprove;
  }
}

/** Stage a pending revision is waiting on, for inbox and blocked-state reporting. */
export function blockedStage(state: KanbanRevisionState): 'pre' | 'final' | null {
  if (state === 'PENDING_PRE_APPROVAL') return 'pre';
  if (state === 'PRE_APPROVED') return 'final';
  return null;
}

/** Throws 409-style guidance for an illegal transition; the caller maps it to ConflictException. */
export function assertTransition(action: RevisionAction, from: KanbanRevisionState): void {
  if (!canTransition(action, from)) {
    throw new ConflictException(`Cannot ${action} a revision that is ${from}`);
  }
}
