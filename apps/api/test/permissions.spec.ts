/** Permission model (catalogue + spec defaults + per-organisation overrides). Pure: no database needed. */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { ADMIN_ONLY_PERMISSIONS, ASSIGNABLE_ROLES, CONFIGURABLE_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, effectivePermissions, Permission } from '../src/common/permissions';

const NON_ADMIN = ['OPERATOR', 'EDITOR', 'PRE_APPROVER', 'APPROVER'] as const;
const ALL = Object.values(Permission);

describe('role set', () => {
  it('exactly five roles are assignable', () => {
    expect([...ASSIGNABLE_ROLES].sort()).toEqual(['ADMIN', 'APPROVER', 'EDITOR', 'OPERATOR', 'PRE_APPROVER']);
  });

  it('Owner and Trainer are never assignable', () => {
    expect(ASSIGNABLE_ROLES).not.toContain('OWNER');
    expect(ASSIGNABLE_ROLES).not.toContain('TRAINER');
  });
});

describe('Admin', () => {
  it('holds every permission, including admin-only ones', () => {
    expect(effectivePermissions('ADMIN', null)).toEqual(new Set(ALL));
  });

  it('is unaffected by stored overrides', () => {
    const stored = { ADMIN: [] };
    expect(effectivePermissions('ADMIN', stored)).toEqual(new Set(ALL));
  });

  it('Owner (legacy) is treated exactly as Admin, not as a separate privilege level', () => {
    expect(effectivePermissions('OWNER', null)).toEqual(effectivePermissions('ADMIN', null));
  });
});

describe('spec defaults', () => {
  const has = (role: 'OPERATOR' | 'EDITOR' | 'PRE_APPROVER' | 'APPROVER', p: Permission) => effectivePermissions(role, null).has(p);

  it('Viewer is read-only by default', () => {
    for (const p of CONFIGURABLE_PERMISSIONS) {
      const writes = !['kanban.view', 'sop.view', 'checklist.complete', 'share.export', 'skills.view'].includes(p);
      if (writes) expect({ p, granted: has('OPERATOR', p) }).toEqual({ p, granted: false });
    }
  });

  it('Editor can create, edit and submit, but cannot publish or approve', () => {
    expect(has('EDITOR', Permission.KanbanCreate) && has('EDITOR', Permission.KanbanEdit) && has('EDITOR', Permission.KanbanSubmit)).toBe(true);
    expect(has('EDITOR', Permission.SopCreate) && has('EDITOR', Permission.SopEdit) && has('EDITOR', Permission.SopSubmit)).toBe(true);
    for (const p of [Permission.KanbanPublish, Permission.KanbanApprove, Permission.KanbanPreApprove, Permission.SopPublish, Permission.SopApprove, Permission.SopPreApprove]) {
      expect({ p, granted: has('EDITOR', p) }).toEqual({ p, granted: false });
    }
  });

  it('Pre Approver can review and pre-approve, but cannot publish', () => {
    expect(has('PRE_APPROVER', Permission.KanbanPreApprove)).toBe(true);
    expect(has('PRE_APPROVER', Permission.SopPreApprove)).toBe(true);
    expect(has('PRE_APPROVER', Permission.KanbanPublish)).toBe(false);
    expect(has('PRE_APPROVER', Permission.SopPublish)).toBe(false);
  });

  it('Approver can approve and publish directly, without pre-approval rights', () => {
    expect(has('APPROVER', Permission.KanbanApprove) && has('APPROVER', Permission.KanbanPublish)).toBe(true);
    expect(has('APPROVER', Permission.SopApprove) && has('APPROVER', Permission.SopPublish)).toBe(true);
    expect(has('APPROVER', Permission.KanbanPreApprove)).toBe(false);
  });
});

describe('Approver defaults are limited to approval, review, publishing and the work they depend on', () => {
  const approverOnly = ['folders.edit', 'checklist.view_all', 'analytics.view', 'analytics.view_all', 'skills.update'] as const;
  it.each(approverOnly)('Approver does not hold unrelated permission %s', (p) => {
    expect(effectivePermissions('APPROVER', null).has(p as Permission)).toBe(false);
  });
  it('Approver holds direct-publish and bulk publish authority', () => {
    expect(effectivePermissions('APPROVER', null).has(Permission.KanbanBulk)).toBe(true);
    expect(effectivePermissions('APPROVER', null).has(Permission.KanbanPublish)).toBe(true);
  });
});

describe('overrides', () => {
  it('replace the role default with exactly the configured list', () => {
    const granted = effectivePermissions('EDITOR', { EDITOR: ['kanban.view', 'kanban.publish'] });
    expect([...granted].sort()).toEqual(['authenticated', 'kanban.publish', 'kanban.view'].sort());
  });

  it('removing a permission removes the capability on the next evaluation', () => {
    expect(effectivePermissions('APPROVER', null).has(Permission.KanbanPublish)).toBe(true);
    const withoutPublish = effectivePermissions('APPROVER', { APPROVER: DEFAULT_ROLE_PERMISSIONS.APPROVER.filter((p) => p !== Permission.KanbanPublish) });
    expect(withoutPublish.has(Permission.KanbanPublish)).toBe(false);
  });

  it('admin-only permissions can never be granted to a non-Admin role', () => {
    for (const role of NON_ADMIN) {
      const granted = effectivePermissions(role, { [role]: ALL });
      for (const p of ADMIN_ONLY_PERMISSIONS) expect({ role, p, granted: granted.has(p) }).toEqual({ role, p, granted: false });
    }
  });

  it('unknown permission strings are ignored, not granted', () => {
    expect(effectivePermissions('EDITOR', { EDITOR: ['made.up', 'kanban.view'] }).has('made.up' as Permission)).toBe(false);
  });

  it('is deterministic for the same input', () => {
    const stored = { EDITOR: ['sop.view', 'sop.submit'] };
    expect(effectivePermissions('EDITOR', stored)).toEqual(effectivePermissions('EDITOR', stored));
  });

  it('every non-Admin role always has Authenticated, even with an empty override', () => {
    for (const role of NON_ADMIN) expect(effectivePermissions(role, { [role]: [] }).has(Permission.Authenticated)).toBe(true);
  });
});

describe('no parallel authorization system', () => {
  it('the removed hard-coded matrix is not referenced anywhere', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.ts$/.test(name) && /PERMISSION_MATRIX|roleHasPermission/.test(readFileSync(path, 'utf8'))) offenders.push(path);
      }
    };
    walk(join(__dirname, '..', 'src'));
    walk(__dirname);
    expect(offenders.filter((f) => !f.endsWith('permissions.spec.ts'))).toEqual([]);
  });
});
