import type { KanbanRevisionState, SopStatus, VersionState } from '@/lib/types';

const SOP_STATUS: Record<SopStatus, { label: string; cls: string }> = {
  draft: { label: 'Draft', cls: '' },
  pending_approval: { label: 'Pending approval', cls: 'badge-amber' },
  approved: { label: 'Approved', cls: 'badge-blue' },
  published: { label: 'Published', cls: 'badge-green' },
  archived: { label: 'Archived', cls: '' },
};

const VERSION_STATE: Record<VersionState, { label: string; cls: string }> = {
  DRAFT: { label: 'Draft', cls: '' },
  PENDING_PRE_APPROVAL: { label: 'Pending pre-approval', cls: 'badge-amber' },
  PENDING_APPROVAL: { label: 'Pending approval', cls: 'badge-amber' },
  APPROVED: { label: 'Approved', cls: 'badge-blue' },
  PUBLISHED: { label: 'Published', cls: 'badge-green' },
  ABANDONED: { label: 'Abandoned', cls: 'badge-red' },
};

/**
 * List-level SOP status. `lifecycle` is the active version's state; it separates Pre Approval from final approval,
 * which the derived SOP status does not. Quorum progress is shown only from API-provided counts.
 */
export function SopStatusBadge({ status, approvals, quorum, lifecycle }: { status: SopStatus; approvals?: number; quorum?: number; lifecycle?: VersionState }) {
  if (status === 'pending_approval' && lifecycle === 'PENDING_PRE_APPROVAL') {
    return <span className="badge badge-amber">Pending pre-approval</span>;
  }
  const s = SOP_STATUS[status];
  const suffix = status === 'pending_approval' && quorum ? ` · ${approvals ?? 0}/${quorum} approved` : '';
  return <span className={`badge ${s.cls}`}>{s.label + suffix}</span>;
}

export function VersionStateBadge({ state }: { state: VersionState }) {
  const s = VERSION_STATE[state];
  return <span className={`badge ${s.cls}`}>{s.label}</span>;
}

const KANBAN_REVISION: Record<KanbanRevisionState, { label: string; cls: string }> = {
  DRAFT: { label: 'Draft', cls: '' },
  PENDING_PRE_APPROVAL: { label: 'Pending pre-approval', cls: 'badge-amber' },
  PRE_APPROVED: { label: 'Pending approval', cls: 'badge-amber' },
  APPROVED: { label: 'Approved', cls: 'badge-blue' },
  PUBLISHED: { label: 'Published', cls: 'badge-green' },
  DISCARDED: { label: 'Discarded', cls: 'badge-red' },
};

/**
 * Kanban revision stage. `rejected` (a DRAFT that carries a reviewer comment) and `blocked` (a pending stage with no
 * eligible approver) are flags the API reports alongside the state, not states of their own.
 */
export function KanbanRevisionBadge({ state, rejected, blocked }: { state: KanbanRevisionState; rejected?: boolean; blocked?: boolean }) {
  if (blocked) return <span className="badge badge-red">Blocked</span>;
  if (rejected && state === 'DRAFT') return <span className="badge badge-red">Rejected</span>;
  const s = KANBAN_REVISION[state];
  return <span className={`badge ${s.cls}`}>{s.label}</span>;
}
