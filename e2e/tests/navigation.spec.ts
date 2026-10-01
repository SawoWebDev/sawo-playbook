/** Navigation, role-based UI, folders, search, settings and analytics pages. */
import { expect, test } from '@playwright/test';
import { acceptInvite, email, invite, newUserContext, RUN, signup } from './helpers';

test('owner navigation: every module page renders without errors', async ({ browser }) => {
  const { context, page } = await newUserContext(browser);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signup(page, 'Nav Co', 'Nora Nav', email('nav-owner'));
  const pages: [string, string][] = [
    ['Checklists', 'Checklists'],
    ['Folders', 'FOLDERS'],
    ['Analytics', 'Analytics'],
    ['Manage Users', 'Manage Users'],
    ['Organization', 'Organization settings'],
    ['Audit Log', 'Audit log'],
  ];
  for (const [link, heading] of pages) {
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.locator('.topbar .menu-list').getByRole('link', { name: link, exact: true }).click();
    await expect(page.getByRole('heading', { name: new RegExp(heading), level: 1 })).toBeVisible();
  }
  for (const tab of ['KANBANS', 'SKILLS', 'STD OPS']) {
    await page.locator('.tabs').getByRole('link', { name: new RegExp(`^${tab}`) }).click();
    await expect(page.locator('.tabs a.active')).toHaveText(new RegExp(`^${tab}`));
  }
  await expect(page.locator('.error')).toHaveCount(0);
  expect(errors).toEqual([]);
  await context.close();
});

test('operator sees a reduced menu and is refused admin pages', async ({ browser }) => {
  const owner = await newUserContext(browser);
  await signup(owner.page, 'Role Co', 'Rob Owner', email('role-owner'));
  const path = await invite(owner.page, email('role-op'), 'Operator / Viewer');
  const op = await newUserContext(browser);
  await acceptInvite(op.page, path, 'Opal Operator');

  await expect(op.page.locator('.tabs').getByRole('link', { name: /^STD OPS/ })).toBeVisible();
  await op.page.getByRole('button', { name: 'Account menu' }).click();
  const sidebar = op.page.locator('.topbar .menu-list');
  for (const hidden of ['Manage Users', 'Organization', 'Audit Log', 'Analytics']) {
    await expect(sidebar.getByRole('link', { name: hidden })).toHaveCount(0);
  }
  await op.page.goto('/users');
  await expect(op.page.locator('.error')).toHaveText('Insufficient permission');
  await op.page.goto('/sops');
  await expect(op.page.getByRole('button', { name: '+ Create New' })).toHaveCount(0);
  await owner.context.close();
  await op.context.close();
});

test('folders: create tree, file an SOP, filter, global search, settings and analytics', async ({ browser }) => {
  const { context, page } = await newUserContext(browser);
  await signup(page, 'Folder Co', 'Fay Folder', email('folder-owner'));

  await page.goto('/folders');
  await page.getByPlaceholder('New folder name').fill('Assembly');
  await page.getByRole('button', { name: 'Create folder' }).click();
  await expect(page.getByRole('link', { name: 'Assembly' })).toBeVisible();
  page.once('dialog', (d) => d.accept('Line 1'));
  await page.getByRole('button', { name: '+ Subfolder' }).click();
  await expect(page.getByRole('link', { name: 'Line 1' })).toBeVisible();

  // duplicate sibling name → error shown
  await page.getByPlaceholder('New folder name').fill('assembly');
  await page.getByRole('button', { name: 'Create folder' }).click();
  await expect(page.locator('.error')).toContainText('already exists');

  // create SOP inside Line 1
  const sopName = `Torque bolts ${RUN}`;
  await page.goto('/sops');
  await page.getByRole('button', { name: '+ Create New' }).click();
  await page.getByRole('button', { name: 'Standard SOP' }).click();
  await page.getByLabel('Procedure name').fill(sopName);
  const line1 = await page.locator('#f option', { hasText: 'Line 1' }).getAttribute('value');
  await page.locator('#f').selectOption(line1!);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page).toHaveURL(/\/edit\//);
  await page.getByRole('button', { name: '+ Add New Step' }).click();
  await page.locator('.rte').click();
  await page.keyboard.type('Torque M8 bolts to 25 Nm in a star pattern.');
  await page.getByRole('button', { name: 'Save As Draft' }).click();
  await expect(page.getByText('Draft saved.')).toBeVisible();
  await page.goto(new URL(page.url()).pathname.replace(/\/edit\/.*$/, ''));
  await expect(page.getByRole('heading', { name: sopName })).toBeVisible();
  await expect(page.getByText('1 step', { exact: true })).toBeVisible();

  // folder filter including subfolders
  await page.goto('/folders');
  await page.getByRole('link', { name: 'Assembly' }).click();
  await expect(page).toHaveURL(/folder=.*sub=1/);
  await expect(page.locator('.sop-card', { hasText: sopName })).toBeVisible();

  // global search over step content (draft visible to owner)
  await page.getByPlaceholder('Search SOPs and kanbans…').fill('torque star');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/search\?q=/);
  await expect(page.locator('.sop-card', { hasText: sopName })).toContainText('draft content');

  // settings: approval is optional (off by default); quorum only appears when it is on
  await page.goto('/settings');
  await expect(page.getByLabel('Require approval before publishing')).not.toBeChecked();
  await expect(page.getByLabel(/Approval quorum/)).toHaveCount(0);
  await page.getByLabel('Require approval before publishing').check();
  await page.getByLabel(/Approval quorum/).fill('2');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Require approval before publishing')).toBeChecked();
  await expect(page.getByLabel(/Approval quorum/)).toHaveValue('2');

  // analytics reflects activity
  await page.goto('/analytics');
  await expect(page.getByText('Whole organization')).toBeVisible();
  await expect(page.locator('.card', { hasText: 'Events' })).toContainText('sop.created');
  await context.close();
});
