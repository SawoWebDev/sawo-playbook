/** Kanban display helpers (kept in step with the printed card in apps/api/src/kanbans/kanban-print.ts). */

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
