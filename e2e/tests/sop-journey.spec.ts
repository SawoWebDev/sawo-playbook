/**
 * End-to-end SOP lifecycle through the real UI:
 * signup → invites (Mailpit) → create SOP with step media → submit →
 * 3-approver quorum (author cannot approve) → publish → share/QR/labels →
 * checklist run → kiosk → skills matrix.
 */
import { BrowserContext, expect, Page, test } from '@playwright/test';
import { acceptInvite, email, invite, mailTo, newUserContext, PNG, RUN, signup } from './helpers';

test.describe.configure({ mode: 'serial' });

type Actor = { context: BrowserContext; page: Page; name: string; mail: string };
const actors: Record<'owner' | 'admin' | 'approver1' | 'approver2' | 'operator', Actor> = {} as never;
const SOP_NAME = `Press guard check ${RUN}`;
let sopUrl = '';
let qrToken = '';

test.afterAll(async () => {
  for (const a of Object.values(actors)) await a?.context.close();
});

test('owner signs up and invites the team (emails delivered via Mailpit)', async ({ browser }) => {
  const owner = await newUserContext(browser);
  actors.owner = { ...owner, name: 'Olivia Owner', mail: email('owner') };
  await signup(owner.page, `E2E Manufacturing ${RUN}`, actors.owner.name, actors.owner.mail);

  const team: [keyof typeof actors, string, string][] = [
    ['admin', 'Adam Admin', 'Admin'],
    ['approver1', 'April Approver', 'Approver'],
    ['approver2', 'Aaron Approver', 'Approver'],
    ['operator', 'Oscar Operator', 'Operator / Viewer'],
  ];
  for (const [key, name, role] of team) {
    const mail = email(key);
    const path = await invite(owner.page, mail, role);
    const delivered = await mailTo(mail);
    expect(delivered?.Subject).toContain("You're invited");
    expect(delivered?.Text).toContain(path);
    const ctx = await newUserContext(browser);
    await acceptInvite(ctx.page, path, name);
    actors[key] = { ...ctx, name, mail };
  }

  await owner.page.goto('/users');
  for (const a of Object.values(actors)) await expect(owner.page.getByRole('cell', { name: a.mail })).toBeVisible();
  // pending invitations list is empty again
  await expect(owner.page.getByText('No pending invitations.')).toBeVisible();

  // This organization uses the optional approval workflow (off by default)
  await owner.page.goto('/settings');
  await owner.page.getByLabel('Require approval before publishing').check();
  await owner.page.getByLabel(/Approval quorum/).fill('3');
  await owner.page.getByRole('button', { name: 'Save settings' }).click();
  await expect(owner.page.getByText('Settings saved.')).toBeVisible();
});

test('owner creates a Checklist SOP with steps and a step image', async () => {
  const { page } = actors.owner;
  await page.goto('/sops');
  await page.getByRole('button', { name: '+ Create New' }).click();
  // Phase 3 options are visible but disabled
  await expect(page.getByRole('button', { name: /Video SOP/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Upload Document/ })).toBeDisabled();
  await page.getByRole('button', { name: 'Standard SOP' }).click();
  await page.getByLabel('Procedure name').fill(SOP_NAME);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page).toHaveURL(/\/sops\/[0-9a-f-]+\/edit\/[0-9a-f-]+/);

  await page.getByLabel('Checklist SOP').check();
  await page.getByRole('button', { name: /Advanced Options/ }).click();
  await page.getByLabel('Change summary').fill('Initial release');

  await page.getByRole('button', { name: '+ Add New Step' }).click();
  const step1 = page.locator('.editor-step').nth(0);
  await step1.locator('.rte').click();
  await page.keyboard.type('Confirm the light curtain is active before cycling the press.');
  await step1.getByLabel('Is this step critical?').check();
  await step1.getByPlaceholder('HH:MM:SS').fill('00:00:30');
  await step1.getByPlaceholder('HH:MM:SS').press('Tab');
  await step1.locator('input[type=file]').first().setInputFiles({ name: 'guard.png', mimeType: 'image/png', buffer: PNG });
  await expect(step1.locator('.thumb img')).toHaveCount(1);
  await expect(step1.locator('.thumb img')).toHaveAttribute('src', /\/api\/files\/.+sig=/);

  await page.getByRole('button', { name: '+ Add New Step' }).click();
  const step2 = page.locator('.editor-step').nth(1);
  await step2.locator('.rte').click();
  await page.keyboard.type('Check hydraulic oil level in the sight glass.');
  await step2.getByPlaceholder('HH:MM:SS').fill('00:01:00');
  await step2.getByPlaceholder('HH:MM:SS').press('Tab');
  await expect(page.getByText('Cycle time 1m 30s')).toBeVisible();

  // Save As Draft keeps the author in the editor
  await page.getByRole('button', { name: 'Save As Draft' }).click();
  await expect(page.getByText('Draft saved.')).toBeVisible();
  await expect(page).toHaveURL(/\/edit\//);
  sopUrl = new URL(page.url()).pathname.replace(/\/edit\/.*$/, '');
  await page.goto(sopUrl);
  await expect(page.getByRole('heading', { name: SOP_NAME })).toBeVisible();
  await expect(page.getByText('2 steps')).toBeVisible();
  await expect(page.getByText('Confirm the light curtain is active')).toBeVisible();
  await expect(page.locator('.step-card.critical')).toHaveCount(1);
});

test('submit; author cannot approve; quorum of 3 distinct approvers; publish', async () => {
  const { page } = actors.owner;
  await page.goto(sopUrl);
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByText('Submitted for approval.')).toBeVisible();
  await expect(page.getByText('Pending approval · 0/3 approved')).toBeVisible();
  await expect(page.getByText('You submitted this version, so you cannot approve it.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);

  // Reject requires a comment
  const a1 = actors.approver1.page;
  await a1.goto(sopUrl);
  await expect(a1.getByRole('button', { name: 'Reject' })).toBeDisabled();

  const order: (keyof typeof actors)[] = ['approver1', 'approver2', 'admin'];
  for (const [i, who] of order.entries()) {
    const p = actors[who].page;
    await p.goto(sopUrl);
    await p.getByRole('button', { name: 'Approve' }).click();
    await expect(p.getByText('Approval recorded.')).toBeVisible();
    if (i < 2) {
      await expect(p.getByText(`${i + 1}/3 approved`).first()).toBeVisible();
      await expect(p.getByText('You have already recorded your decision for this round.')).toBeVisible();
      await expect(p.getByRole('button', { name: 'Publish' })).toHaveCount(0);
    }
  }

  // Editor-level users never see Publish; the approver publishes
  await a1.goto(sopUrl);
  await a1.getByRole('button', { name: 'Publish' }).click();
  await expect(a1.getByText('Version published.')).toBeVisible();
  await expect(a1.locator('.badge', { hasText: 'Published' }).first()).toBeVisible();
  await expect(a1.getByText(/approved/).first()).toBeVisible();
});

test('share panel: QR image, print labels, QR landing page (logged in and out)', async ({ browser }) => {
  const { page } = actors.owner;
  await page.goto(sopUrl);
  const qr = page.getByRole('img', { name: 'QR code' });
  await expect(qr).toBeVisible();
  expect(await qr.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  const shareText = (await page.locator('.card', { hasText: 'Share' }).textContent()) ?? '';
  const m = shareText.match(/\/s\/([A-Za-z0-9_-]{24})/); // tokens are 18 random bytes → 24 base64url chars
  expect(m).not.toBeNull();
  qrToken = m![1];

  const [labels] = await Promise.all([page.context().waitForEvent('page'), page.getByRole('link', { name: 'View or Print QR Code' }).click()]);
  await expect(labels.locator('.qr-label')).toHaveCount(1);
  await labels.getByLabel('Copies').fill('4');
  await expect(labels.locator('.qr-label')).toHaveCount(4);
  await expect(labels.locator('.qr-label .name').first()).toHaveText(SOP_NAME);
  await labels.close();

  // Scanning while signed in opens the SOP (current published version)
  await page.goto(`/s/${qrToken}`);
  await expect(page).toHaveURL(new RegExp(`${sopUrl}$`));
  await expect(page.getByRole('heading', { name: SOP_NAME })).toBeVisible();

  // Scanning while signed out never grants access: redirected to login, then back
  const anon = await newUserContext(browser);
  await anon.page.goto(`/s/${qrToken}`);
  await expect(anon.page).toHaveURL(/\/login\?next=/);
  await anon.context.close();

  // Invalid code
  await page.goto('/s/not-a-real-token-000000');
  await expect(page.getByText('This QR code is not valid.')).toBeVisible();
});

test('operator runs the checklist against the published version', async () => {
  const { page } = actors.operator;
  await page.goto('/sops');
  await page.getByRole('link', { name: new RegExp(SOP_NAME) }).click();
  await expect(page.getByRole('heading', { name: SOP_NAME })).toBeVisible();
  // operators have no edit/approve controls
  await expect(page.getByRole('button', { name: 'Submit for approval' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Start checklist' }).click();
  await expect(page).toHaveURL(/\/checklists\/[0-9a-f-]+/);
  await expect(page.getByText('0/2 answered')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Complete checklist' })).toBeDisabled();

  const cards = page.locator('.step-card');
  await cards.nth(0).getByRole('button', { name: 'OK', exact: true }).click();
  await expect(page.getByText('1/2 answered')).toBeVisible();
  await cards.nth(1).getByPlaceholder('Comment').fill('Oil slightly low');
  await cards.nth(1).getByRole('button', { name: 'NOT OK' }).click();
  await expect(page.getByText('2/2 answered')).toBeVisible();
  await page.getByRole('button', { name: 'Complete checklist' }).click();
  await expect(page.locator('.badge', { hasText: 'completed' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'OK', exact: true })).toHaveCount(0);

  await page.goto('/checklists');
  const row = page.getByRole('row', { name: new RegExp(SOP_NAME) });
  await expect(row).toContainText('2/2');
  await expect(row).toContainText('1 NOT OK');
  await expect(row).toContainText('completed');
});

test('kiosk mode steps through the current version', async () => {
  const { page } = actors.operator;
  await page.goto(sopUrl.replace('/sops/', '/kiosk/'));
  await expect(page.getByLabel('Go to step')).toHaveValue('0');
  await expect(page.getByText('CRITICAL')).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByLabel('Go to step')).toHaveValue('1');
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByLabel('Go to step')).toHaveValue('0');
  await page.getByRole('link', { name: 'Back' }).click();
  await expect(page).toHaveURL(new RegExp(`${sopUrl}$`));
});

test('owner records a skills-matrix assessment; operator sees only their own row', async () => {
  const { page } = actors.owner;
  await page.goto('/skills');
  const row = page.locator('.skills-matrix').getByRole('row', { name: new RegExp(actors.operator.name) });
  await expect(row).toBeVisible();
  await row.locator('.skill-cell').first().click();
  await expect(page.getByRole('heading', { name: `Assess ${actors.operator.name}` })).toBeVisible();
  await page.getByLabel(/3 — Able to Work Alone/).check();
  await page.getByLabel('Notes').fill('Signed off on press line 2');
  await page.getByRole('button', { name: 'Record assessment' }).click();
  await expect(page.getByRole('heading', { name: /^Assess / })).toHaveCount(0);
  const history = page.getByRole('row', { name: /Signed off on press line 2/ });
  await expect(history).toContainText(actors.operator.name);
  await expect(history).toContainText('Able to Work Alone');
  await expect(row.locator('svg[aria-label="Level 3"]').first()).toBeVisible();

  const op = actors.operator.page;
  await op.goto('/skills');
  await expect(op.locator('.skills-matrix tbody tr')).toHaveCount(1);
  await expect(op.locator('.skills-matrix tbody tr')).toContainText(actors.operator.name);
  await expect(op.locator('.skill-cell').first()).toBeDisabled();
});

test('editing the published SOP creates version 1.002 while 1.001 stays current', async () => {
  const { page } = actors.owner;
  await page.goto(sopUrl);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.getByText('v1.002 draft')).toBeVisible();
  await expect(page.locator('.editor-step')).toHaveCount(2);
  await page.getByRole('button', { name: '+ Add New Step' }).click();
  await page.locator('.editor-step').nth(2).locator('.rte').click();
  await page.keyboard.type('Record the check in the shift log.');
  await page.getByRole('button', { name: 'Save As Draft' }).click();
  await expect(page.getByText('Draft saved.')).toBeVisible();
  await page.goto(sopUrl);
  await expect(page.getByText('Version 1.002')).toBeVisible();
  await expect(page.getByText('3 steps')).toBeVisible();

  // the operator still sees the published 1.001 with 2 steps
  const op = actors.operator.page;
  await op.goto(sopUrl);
  await expect(op.getByText('Version 1.001')).toBeVisible();
  await expect(op.getByText('2 steps')).toBeVisible();
});
