import type { SopStatus, VersionState } from '@/lib/types';

const SOP_STATUS: Record<SopStatus, { label: string; cls: string }> = {
  draft: { label: 'Draft', cls: '' },
  pending_approval: { label: 'Pending approval', cls: 'badge-amber' },
  approved: { label: 'Approved', cls: 'badge-blue' },
  published: { label: 'Published', cls: 'badge-green' },
  archived: { label: 'Archived', cls: '' },
};

const VERSION_STATE: Record<VersionState, { label: string; cls: string }> = {
  DRAFT: { label: 'Draft', cls: '' },
  PENDING_APPROVAL: { label: 'Pending approval', cls: 'badge-amber' },
  APPROVED: { label: 'Approved', cls: 'badge-blue' },
  PUBLISHED: { label: 'Published', cls: 'badge-green' },
  ABANDONED: { label: 'Abandoned', cls: 'badge-red' },
};

export function SopStatusBadge({ status, approvals, quorum }: { status: SopStatus; approvals?: number; quorum?: number }) {
  const s = SOP_STATUS[status];
  const suffix = status === 'pending_approval' && quorum ? ` · ${approvals ?? 0}/${quorum} approved` : '';
  return <span className={`badge ${s.cls}`}>{s.label + suffix}</span>;
}

export function VersionStateBadge({ state }: { state: VersionState }) {
  const s = VERSION_STATE[state];
  return <span className={`badge ${s.cls}`}>{s.label}</span>;
}
