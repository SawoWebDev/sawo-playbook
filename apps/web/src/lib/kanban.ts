/** Kanban display helpers (kept in step with the printed card in apps/api/src/kanbans/kanban-print.ts). */
import { api } from './api';
import type { KanbanInbox, KanbanRevisionState } from './types';

/** The description without a leading "[CODE]" — some descriptions already start with the part code. */
export function kanbanDescription(k: { partCode: string; partDescription: string | null }): string {
  const desc = (k.partDescription ?? '').trim();
  const prefix = `[${k.partCode}]`;
  return desc.toUpperCase().startsWith(prefix.toUpperCase()) ? desc.slice(prefix.length).trim() : desc;
}

/** "[CODE] description", with the part code shown once. */
export function kanbanTitle(k: { partCode: string; partDescription: string | null }): string {
  const desc = kanbanDescription(k);
  return desc ? `[${k.partCode}] ${desc}` : k.partCode;
}

/**
 * Loads the approval inbox. Cards take their review state from `openRevision` and their actions from the revision,
 * so the inbox is read only for the blocked reason, which the card API does not carry.
 */
export function fetchKanbanInbox(): Promise<KanbanInbox> {
  return api<KanbanInbox>('/kanbans/revisions');
}

/** Blocked reasons by card id, from the server's blocked list. A card absent from the map is not blocked. */
export function blockedReasons(inbox: KanbanInbox | null): Map<string, string> {
  const map = new Map<string, string>();
  for (const i of inbox?.blocked ?? []) {
    if (i.kanbanId) map.set(i.kanbanId, i.blockedReason ?? 'No eligible approver for this stage.');
  }
  return map;
}

/** A revision is locked for editing while it is in review. The server rejects edits in these states with 409. */
export function isLockedForEdit(state: KanbanRevisionState): boolean {
  return state === 'PENDING_PRE_APPROVAL' || state === 'PRE_APPROVED' || state === 'APPROVED';
}
