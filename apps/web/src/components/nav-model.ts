/**
 * The sidebar menu. "Work" and "Review" can be reordered and hidden by an Admin (Organization settings > Sidebar menu);
 * "Administration" is fixed so nobody can hide the screens that bring a hidden item back.
 * Keep the customisable hrefs in step with NAV_ITEMS in apps/api/src/organization/organization.service.ts.
 */

export type NavSection = { key: string; label: string; customizable?: boolean; items: NavItem[] };

/** Saved menu: `order` lists item hrefs in the wanted order, `hidden` the ones not to show. */
export interface NavConfig {
  order: string[];
  hidden: string[];
}

/** Dispatched on `window` after the menu is saved so the sidebar re-reads it straight away. */
export const NAV_CONFIG_EVENT = 'nav-config-changed';

/** Font Awesome solid icon class names, as the REACT_SITE sidebar uses them. */
export type NavItem = {
  href: string;
  label: string;
  description: string;
  icon: string;
  cap?: string;
  hidden?: boolean;
};

export const SECTIONS: NavSection[] = [
  {
    key: 'work',
    label: 'Work',
    customizable: true,
    items: [
      { href: '/sops', label: 'Standard Ops', icon: 'fa-file-lines', cap: 'sop.view', description: 'Standard operating procedures: draft, approve, publish and print.' },
      { href: '/kanbans', label: 'Kanbans', icon: 'fa-table-columns', cap: 'sop.view', description: 'Kanban cards for parts and ordering. Edits are drafted, approved, then published.' },
      { href: '/skills', label: 'Skills', icon: 'fa-certificate', cap: 'skills.view', description: 'Training and skill sign-off records for operators.' },
      { href: '/folders', label: 'Folders', icon: 'fa-folder', cap: 'sop.view', description: 'Organise standard operating procedures into folders.' },
      { href: '/checklists', label: 'Checklists', icon: 'fa-list-check', cap: 'sop.view', description: 'Checklist runs recorded against published SOPs.' },
    ],
  },
  {
    key: 'review',
    label: 'Review',
    customizable: true,
    items: [
      { href: '/approvals', label: 'Approvals', icon: 'fa-inbox', cap: 'sop.view', description: 'Everything waiting on pre-approval, approval or publishing.' },
      { href: '/analytics', label: 'Analytics', icon: 'fa-chart-line', cap: 'analytics.view', description: 'Usage and training analytics.' },
    ],
  },
  {
    key: 'admin',
    label: 'Administration',
    items: [
      { href: '/users', label: 'Manage Users', icon: 'fa-users', cap: 'users.manage', description: 'Invite people, set their roles and manage their access.' },
      { href: '/groups', label: 'Groups', icon: 'fa-user-group', cap: 'groups.manage', description: 'Groups decide which approvers see which SOPs and kanbans.' },
      { href: '/roles', label: 'Roles / Permissions', icon: 'fa-shield-halved', cap: 'roles.manage', description: 'What each role is allowed to do.' },
      { href: '/settings', label: 'Organization', icon: 'fa-building', cap: 'org.settings.manage', description: 'Organisation settings, including approval quorum and self-approval.' },
      { href: '/backups', label: 'Backups', icon: 'fa-database', cap: 'org.settings.manage', description: 'Create and restore full backups of this organisation.' },
      { href: '/audit', label: 'Audit Log', icon: 'fa-clipboard-list', cap: 'audit.view', description: 'A record of changes and approval decisions.' },
    ],
  },
];

/** The items of a section as the saved menu wants them: hidden ones removed, the rest in the saved order. */
export function applyNavConfig(section: NavSection, cfg: NavConfig | null): NavItem[] {
  if (!section.customizable || !cfg) return section.items;
  const rank = (href: string, fallback: number) => {
    const i = cfg.order.indexOf(href);
    return i === -1 ? 1000 + fallback : i;
  };
  return section.items
    .map((item, i) => ({ item, key: rank(item.href, i) }))
    .filter(({ item }) => !cfg.hidden.includes(item.href))
    .sort((a, b) => a.key - b.key)
    .map(({ item }) => item);
}
