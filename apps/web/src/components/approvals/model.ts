import { api } from '@/lib/api';
import type { KanbanRevisionActions } from '@/lib/types';

/**
 * Approval Center model. It only combines the existing inbox endpoints (GET /sops/approvals, GET /kanbans/revisions)
 * and the existing SOP approval detail (GET /sops/:id/versions/:vid/approvals). Every list membership, action and
 * quorum figure comes from the server; nothing here decides who may act or what a stage requires.
 */

/** The server's own lists. An item's sections say why it appears: the server put it there. */
export type Section = 'preApproval' | 'finalApproval' | 'readyToPublish' | 'blocked' | 'rejected' | 'mine';

export interface SopActions {
  preApprove?: boolean;
  approve?: boolean;
  reject?: boolean;
  publish?: boolean;
}

export interface ApprovalItem {
  /** Unique across both kinds. */
  key: string;
  kind: 'sop' | 'kanban';
  /** SOP version id, or Kanban revision id. */
  id: string;
  /** SOP id, or Kanban card id (null for a card not yet published). */
  parentId: string | null;
  title: string;
  reference: string | null;
  /** Server state value, shown verbatim (e.g. PENDING_PRE_APPROVAL). */
  state: string;
  submitter: string | null;
  submittedAt: string | null;
  /** Routed group names for SOP items; Kanban items expose only group ids. */
  groupNames: string[] | null;
  groupCount: number;
  blockedReason: string | null;
  comment: string | null;
  sections: Set<Section>;
  /** SOP-only: from the SOP's own actions. */
  sopActions: SopActions | null;
  /** Kanban-only: the revision's action flags from the server. */
  kanbanActions: KanbanRevisionActions | null;
  /** SOP-only: quorum from the SOP detail endpoint, loaded for pending SOP items. */
  quorum: { required: number; current: number; remaining: number } | null;
}

type Named = { id: string; name: string | null };

interface SopInboxItem {
  sopId: string;
  versionId: string;
  name: string;
  referenceNo: string;
  label: string;
  state: string;
  stage: 'pre' | 'final' | null;
  submitter: { id: string; name: string | null } | null;
  submittedAt: string | null;
  routingGroups: Named[];
  blocked?: boolean;
  blockedReason?: string | null;
  comment?: string | null;
  actions?: SopActions;
}

interface KanbanInboxItem {
  id: string;
  kanbanId: string | null;
  state: string;
  stage: 'pre' | 'final' | null;
  partCode: string;
  partDescription: string | null;
  submitter: { id: string; name: string | null } | null;
  submittedAt: string | null;
  routingGroupIds?: string[];
  blockedReason?: string | null;
  comment?: string | null;
  actions: KanbanRevisionActions;
}

interface SopInbox {
  preApproval: SopInboxItem[];
  finalApproval: SopInboxItem[];
  readyToPublish: SopInboxItem[];
  blocked: SopInboxItem[];
  rejected: SopInboxItem[];
  mine: SopInboxItem[];
}

interface KanbanInbox {
  preApproval: KanbanInboxItem[];
  finalApproval: KanbanInboxItem[];
  readyToPublish: KanbanInboxItem[];
  blocked: KanbanInboxItem[];
  rejected: KanbanInboxItem[];
  mine: KanbanInboxItem[];
}

interface SopApprovalDetail {
  quorum: { required: number; current: number; remaining: number };
}

const SECTIONS: Section[] = ['preApproval', 'finalApproval', 'readyToPublish', 'blocked', 'rejected', 'mine'];

function merge(map: Map<string, ApprovalItem>, next: ApprovalItem, section: Section) {
  const existing = map.get(next.key);
  if (existing) {
    existing.sections.add(section);
    if (next.blockedReason && !existing.blockedReason) existing.blockedReason = next.blockedReason;
    if (next.comment && !existing.comment) existing.comment = next.comment;
    if (next.sopActions && !existing.sopActions) existing.sopActions = next.sopActions;
    if (next.kanbanActions && !existing.kanbanActions) existing.kanbanActions = next.kanbanActions;
    return;
  }
  next.sections.add(section);
  map.set(next.key, next);
}

function sopItem(i: SopInboxItem): ApprovalItem {
  const names = i.routingGroups.map((g) => g.name ?? 'Unnamed group');
  return {
    key: `sop:${i.versionId}`,
    kind: 'sop',
    id: i.versionId,
    parentId: i.sopId,
    title: i.name,
    reference: `${i.referenceNo} · ${i.label}`,
    state: i.state,
    submitter: i.submitter?.name ?? null,
    submittedAt: i.submittedAt,
    groupNames: names,
    groupCount: names.length,
    blockedReason: i.blockedReason ?? null,
    comment: i.comment ?? null,
    sections: new Set<Section>(),
    sopActions: i.actions ?? null,
    kanbanActions: null,
    quorum: null,
  };
}

function kanbanItem(i: KanbanInboxItem): ApprovalItem {
  return {
    key: `kanban:${i.id}`,
    kind: 'kanban',
    id: i.id,
    parentId: i.kanbanId,
    title: i.partCode,
    reference: i.partDescription,
    state: i.state,
    submitter: i.submitter?.name ?? null,
    submittedAt: i.submittedAt,
    groupNames: null,
    groupCount: i.routingGroupIds?.length ?? 0,
    blockedReason: i.blockedReason ?? null,
    comment: i.comment ?? null,
    sections: new Set<Section>(),
    sopActions: null,
    kanbanActions: i.actions,
    quorum: null,
  };
}

/** Loads both server inboxes and merges them into one list. SOP quorum is read from each pending SOP's own detail. */
export async function loadApprovalItems(): Promise<ApprovalItem[]> {
  const [sop, kanban] = await Promise.all([api<SopInbox>('/sops/approvals'), api<KanbanInbox>('/kanbans/revisions')]);
  const map = new Map<string, ApprovalItem>();
  for (const s of SECTIONS) {
    for (const i of sop[s] as SopInboxItem[]) merge(map, sopItem(i), s);
    for (const i of kanban[s] as KanbanInboxItem[]) merge(map, kanbanItem(i), s);
  }
  const items = [...map.values()];
  // Quorum for pending SOP items, from the server's own detail. Capped so a long queue stays responsive.
  const pendingSops = items.filter((i) => i.kind === 'sop' && i.parentId && (i.state === 'PENDING_APPROVAL' || i.state === 'PENDING_PRE_APPROVAL')).slice(0, 40);
  await Promise.all(
    pendingSops.map(async (i) => {
      try {
        const d = await api<SopApprovalDetail>(`/sops/${i.parentId}/versions/${i.id}/approvals`);
        i.quorum = { required: d.quorum.required, current: d.quorum.current, remaining: d.quorum.remaining };
      } catch {
        i.quorum = null;
      }
    }),
  );
  return items;
}

/** Ordered for the operational list: needs-action first, then blocked, then the rest by submit time (newest first). */
export function sortItems(items: ApprovalItem[]): ApprovalItem[] {
  const rank = (i: ApprovalItem) => (isActionable(i) ? 0 : i.sections.has('blocked') ? 1 : isReady(i) ? 2 : i.sections.has('rejected') ? 3 : 4);
  return [...items].sort((a, b) => rank(a) - rank(b) || (b.submittedAt ?? '').localeCompare(a.submittedAt ?? ''));
}

/** The server put this item in an action list for the caller, and for SOP items the action flag confirms it. */
export function isActionable(i: ApprovalItem): boolean {
  if (i.kind === 'sop') {
    const a = i.sopActions;
    return !!a && (!!a.preApprove || !!a.approve || !!a.publish);
  }
  const k = i.kanbanActions;
  return !!k && (k.preApprove || k.approve || k.publish);
}

/** Ready: the item is in the approved state (SOP items also carry the server's readyToPublish list). */
export function isReady(i: ApprovalItem): boolean {
  return i.state === 'APPROVED' || (i.kind === 'sop' && i.sections.has('readyToPublish'));
}

/** Waiting on someone else: the caller submitted it, it is still pending, and nothing is theirs to do. */
export function isWaiting(i: ApprovalItem): boolean {
  return i.sections.has('mine') && !isActionable(i) && (i.state === 'PENDING_PRE_APPROVAL' || i.state === 'PENDING_APPROVAL' || i.state === 'PRE_APPROVED');
}

export type FilterKey = 'all' | 'needs' | 'blocked' | 'pre' | 'final' | 'ready' | 'rejected' | 'mine';

export const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'needs', label: 'Needs my action' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'pre', label: 'Pre Approval' },
  { key: 'final', label: 'Final Approval' },
  { key: 'ready', label: 'Approved / Ready to Publish' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'mine', label: 'Mine' },
];

/** Filters use the server's section membership and the item's real state. No states are invented. */
export function matches(i: ApprovalItem, f: FilterKey): boolean {
  switch (f) {
    case 'all':
      return true;
    case 'needs':
      return isActionable(i);
    case 'blocked':
      return i.sections.has('blocked');
    case 'pre':
      return i.state === 'PENDING_PRE_APPROVAL';
    case 'final':
      return i.state === 'PENDING_APPROVAL' || (i.kind === 'kanban' && i.state === 'PRE_APPROVED');
    case 'ready':
      return isReady(i);
    case 'rejected':
      return i.sections.has('rejected');
    case 'mine':
      return i.sections.has('mine');
  }
}

/** Human label for a server state. Pure display text; the state set is the server's. */
export const STATE_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  PENDING_PRE_APPROVAL: 'Pending pre-approval',
  PENDING_APPROVAL: 'Pending final approval',
  PRE_APPROVED: 'Pre-approved, awaiting final approval',
  APPROVED: 'Approved',
  PUBLISHED: 'Published',
  DISCARDED: 'Discarded',
};
