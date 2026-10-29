/**
 * @guide — captures the screenshots used by the Editor user guide (docs/user-guide/index.html). Not part of CI.
 * It signs up a throwaway demo organization, so it never touches existing organizations' data.
 * Run (against the dev stack on port 3001):
 *   cd e2e && USER_GUIDE=1 BASE_URL=http://localhost:3001 npx playwright test user-guide
 * Output: docs/user-guide/img/<name>.jpg, then docs/user-guide/SAWO-Playbook-Editor-Guide.pdf (rendered from index.html)
 */
import { Browser, expect, Locator, Page, test } from '@playwright/test';
import path from 'path';
import { pathToFileURL } from 'url';
import { email, newUserContext, PASSWORD, RUN } from './helpers';

test.skip(!process.env.USER_GUIDE, 'user guide screenshots run only with USER_GUIDE=1');

const OUT = '../docs/user-guide/img';
const HIDE_TOASTS = '.toast-stack { display: none !important; }';
/**
 * Viewport screenshot. `full` grows the window to fit the content first: the app scrolls inside its own container, so
 * Playwright's fullPage option alone would still cut the page off.
 */
const shot = async (page: Page, name: string, opts: { full?: boolean } = {}) => {
  const vp = page.viewportSize()!;
  if (opts.full) {
    const extra = await page.evaluate(() =>
      Math.max(0, ...[...document.querySelectorAll<HTMLElement>('*')].map((el) => el.scrollHeight - el.clientHeight).filter((d) => d > 0)),
    );
    if (extra > 0) {
      await page.setViewportSize({ width: vp.width, height: Math.min(vp.height + extra, 4000) });
      await page.waitForTimeout(300);
    }
  }
  await page.screenshot({ path: `${OUT}/${name}.jpg`, type: 'jpeg', quality: 85, animations: 'disabled', style: HIDE_TOASTS });
  if (opts.full) await page.setViewportSize(vp);
};
/** Screenshot of one element (with a little breathing room around it). */
const part = async (page: Page, el: Locator, name: string, pad = 12) => {
  await el.scrollIntoViewIfNeeded();
  const b = (await el.boundingBox())!;
  const vp = page.viewportSize()!;
  const x = Math.max(0, b.x - pad);
  const y = Math.max(0, b.y - pad);
  await page.screenshot({
    path: `${OUT}/${name}.jpg`,
    type: 'jpeg',
    quality: 85,
    animations: 'disabled',
    style: HIDE_TOASTS,
    clip: { x, y, width: Math.min(vp.width - x, b.width + pad * 2), height: Math.min(vp.height - y, b.height + pad * 2) },
  });
};
const settle = async (page: Page) => {
  await page.waitForLoadState('networkidle');
  // inside the app, wait until the signed-in user's menu has rendered (permissions loaded)
  if (!/\/(login|change-password|kiosk)/.test(page.url())) {
    await page.getByRole('link', { name: 'Approvals' }).waitFor({ timeout: 10_000 }).catch(() => {});
  }
  await page.waitForTimeout(400);
};

/**
 * /api/auth/* is rate-limited per client IP (10/min for /auth/me) and every full page load calls it, so a script that
 * opens pages quickly would get an empty menu. Give each auth request its own client IP (honoured via X-Forwarded-For).
 */
let authIp = 0;
async function newSession(browser: Browser) {
  const s = await newUserContext(browser);
  await s.context.route('**/api/auth/**', (route) =>
    route.continue({ headers: { ...route.request().headers(), 'x-forwarded-for': `203.0.113.${(authIp++ % 250) + 1}` } }),
  );
  await s.page.setViewportSize({ width: 1280, height: 800 });
  return s;
}

/** Renders a simple illustrative "photo" (PNG) so steps and cards don't show a blank pixel. */
async function picture(browser: Browser, label: string, bg: string, icon: string): Promise<Buffer> {
  const p = await browser.newPage({ viewport: { width: 640, height: 480 } });
  await p.setContent(`<body style="margin:0;width:640px;height:480px;display:grid;place-items:center;
    background:linear-gradient(135deg,${bg},#1e293b);font-family:Segoe UI,Arial,sans-serif;color:#fff">
    <div style="text-align:center"><div style="font-size:120px;line-height:1">${icon}</div>
    <div style="font-size:34px;font-weight:600;margin-top:18px">${label}</div></div></body>`);
  const buf = await p.screenshot();
  await p.close();
  return buf;
}

const TEMP = 'Temporary-Pass-2026';

async function signup(page: Page, org: string, name: string, mail: string) {
  await page.goto('/signup');
  await page.getByLabel('Organization name').fill(org);
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Email').fill(mail);
  await page.getByLabel('Password (min. 10 characters)').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByRole('link', { name: 'Standard Ops' })).toBeVisible();
}

async function finishPasswordChange(page: Page) {
  await page.locator('#cp-current').fill(TEMP);
  await page.locator('#cp-new').fill(PASSWORD);
  await page.locator('#cp-confirm').fill(PASSWORD);
  await page.locator('form button[type=submit]').click();
  await expect(page.getByRole('link', { name: 'Standard Ops' })).toBeVisible();
}

/** Clicks through Pre Approve / Approve / Publish on a SOP or kanban page until nothing is left to do. */
async function approveAndPublish(page: Page, url: string) {
  await page.goto(url);
  await settle(page);
  for (let i = 0; i < 4; i++) {
    const btn = page.getByRole('button', { name: /^(Pre Approve|Pre-approve|Approve|Publish)$/ }).first();
    if (!(await btn.isVisible().catch(() => false))) break;
    const label = (await btn.textContent())!.trim();
    await btn.click();
    // kanban approvals confirm in a dialog
    const dialog = page.getByRole('dialog');
    if (await dialog.isVisible().catch(() => false)) await dialog.getByRole('button', { name: label, exact: true }).click();
    await settle(page);
  }
}

async function firstLogin(page: Page, mail: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(mail);
  await page.locator('#password').fill(TEMP);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/change-password/);
  await finishPasswordChange(page);
}

test('@guide editor user guide screenshots', async ({ browser }) => {
  test.setTimeout(15 * 60_000);
  const imgIsolate = await picture(browser, 'Lock-out / Tag-out', '#b42318', '🔒');
  const imgFit = await picture(browser, 'Fit the new die', '#1f5fbf', '🔧');
  const imgCheck = await picture(browser, 'Check the alignment', '#1a7f37', '✔');
  const imgPart = await picture(browser, 'Ball bearing 6204', '#475569', '⚙');

  // ── Admin: demo organization with approval switched on, plus an Editor and an Approver ──
  const admin = await newSession(browser);
  await signup(admin.page, `SAWO Demo ${RUN}`, 'Alex Admin', email('admin'));
  await admin.page.goto('/settings');
  await settle(admin.page);
  const req = admin.page.getByRole('switch', { name: 'Require approval before publishing' });
  if (!(await req.isChecked())) await req.check();
  await admin.page.locator('#quorum').fill('1');
  await admin.page.getByRole('button', { name: 'Save settings' }).click();
  await settle(admin.page);
  for (const f of ['Assembly', 'Maintenance', 'Quality']) {
    await admin.page.goto('/folders');
    await admin.page.getByPlaceholder('New folder name').fill(f);
    await admin.page.getByRole('button', { name: 'Create folder' }).click();
    await settle(admin.page);
  }
  const http = admin.context.request;
  const session = await (await http.post('/api/auth/login', { data: { email: email('admin'), password: PASSWORD } })).json();
  const auth = { Authorization: `Bearer ${session.accessToken}` };
  const group = await (await http.post('/api/groups', { headers: auth, data: { name: 'Production' } })).json();
  const editorMail = email('editor');
  const approverMail = email('approver');
  const ids: Record<string, string> = {};
  for (const [name, mail, role] of [
    ['Erin Editor', editorMail, 'EDITOR'],
    ['Pat Approver', approverMail, 'APPROVER'],
    ['Riley Reviewer', email('pre'), 'PRE_APPROVER'],
    ['Sam Operator', email('sam'), 'OPERATOR'],
    ['Jo Operator', email('jo'), 'OPERATOR'],
  ]) {
    const r = await http.post('/api/users', { headers: auth, data: { name, email: mail, role, groupIds: [group.id], temporaryPassword: TEMP } });
    expect(r.ok(), await r.text()).toBeTruthy();
    ids[name] = (await r.json()).id;
  }
  // The Editor records training for the two operators
  for (const who of ['Sam Operator', 'Jo Operator']) {
    const r = await http.post('/api/skills/trainers', { headers: auth, data: { trainerId: ids['Erin Editor'], associateId: ids[who] } });
    expect(r.ok(), await r.text()).toBeTruthy();
  }

  const approver = await newSession(browser);
  await firstLogin(approver.page, approverMail);
  const preApprover = await newSession(browser);
  await firstLogin(preApprover.page, email('pre'));
  const pre = preApprover.page;

  // ── Editor ──
  const ed = await newSession(browser);
  const page = ed.page;
  await page.goto('/login');
  await settle(page);
  await page.getByLabel('Email').fill(editorMail);
  await page.locator('#password').fill(TEMP);
  await shot(page, '01-login');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/change-password/);
  await settle(page);
  await shot(page, '02-change-password');
  await finishPasswordChange(page);
  await settle(page);
  await shot(page, '03-home');
  await part(page, page.locator('nav, aside').first(), '04-sidebar', 0);

  // ── SOPs ──
  await page.goto('/sops');
  await settle(page);
  await shot(page, '10-sops-empty');
  await page.getByRole('button', { name: /Create New/ }).click();
  await page.getByLabel('Procedure name').fill('Changeover of die set on press line 2');
  await page.locator('#f').selectOption({ label: 'Assembly' });
  await shot(page, '11-sop-create-dialog');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page).toHaveURL(/\/edit\//);
  await settle(page);
  await shot(page, '12-sop-editor-top');
  await page.getByRole('switch', { name: 'Advanced SOP' }).check();
  await page.locator('.advanced-toggle').click();
  await page.getByPlaceholder('What changed in this version?').fill('First issue');
  await settle(page);
  await shot(page, '13-sop-editor-config', { full: true });
  await page.locator('.adv-toggle').click();
  await page.getByRole('button', { name: 'Presentation & Formatting' }).click();
  await settle(page);
  await part(page, page.locator('.adv-toggle').locator('xpath=..'), '13b-sop-pdf-options');
  await page.locator('.adv-toggle').click();

  const steps = [
    ['Isolate the press', 'Apply lock-out / tag-out to the main isolator and verify zero energy before touching the tooling.', true, imgIsolate],
    ['Remove the old die', 'Loosen the four clamp bolts and lift the die out with the approved hoist.', false, null],
    ['Fit the new die', 'Align the locating pins and torque the clamp bolts to 120 Nm in a cross pattern.', false, imgFit],
    ['Check alignment', 'Run one slow test stroke and check the first part against the gauge.', false, imgCheck],
  ] as const;
  for (const [i, [title, text, critical, img]] of steps.entries()) {
    await page.getByRole('button', { name: /Add New Step/ }).click();
    const st = page.locator('.editor-step').nth(i);
    await st.getByPlaceholder('Step title').fill(title);
    await st.locator('.rte').click();
    await page.keyboard.type(text);
    await st.getByPlaceholder('HH:MM:SS').fill(`00:0${i + 2}:00`);
    await st.getByPlaceholder('HH:MM:SS').press('Tab');
    if (critical) await st.getByRole('switch', { name: 'Is this step critical?' }).check();
    if (img) await st.locator('input[type=file]').first().setInputFiles({ name: `step-${i + 1}.png`, mimeType: 'image/png', buffer: img });
    else await st.getByRole('switch', { name: 'Text Only Step' }).check();
    await settle(page);
    if (i === 0) await part(page, st, '14-sop-step');
  }
  await settle(page);
  await shot(page, '15-sop-editor-steps', { full: true });
  await page.getByRole('button', { name: /Finish & Submit/ }).click();
  await expect(page).toHaveURL(/\/sops\/[0-9a-f-]+(\?.*)?$/);
  await settle(page);
  await shot(page, '17-sop-pending', { full: true });
  const sopUrl = new URL(page.url()).pathname;

  await page.goto('/approvals');
  await settle(page);
  await page.getByRole('button', { name: /^Mine/ }).click();
  await settle(page);
  await shot(page, '18-approvals-editor');

  // A second SOP (a Checklist SOP) that the approver sends back
  await page.goto('/sops');
  await page.getByRole('button', { name: /Create New/ }).click();
  await page.getByLabel('Procedure name').fill('Daily forklift pre-use inspection');
  await page.locator('#f').selectOption({ label: 'Maintenance' });
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page).toHaveURL(/\/edit\//);
  await settle(page);
  await page.getByRole('switch', { name: 'Checklist SOP' }).check();
  for (const [i, text] of ['Check tyres and forks for damage.', 'Test the horn, lights and brakes.', 'Check the hydraulic hoses for leaks.'].entries()) {
    await page.getByRole('button', { name: /Add New Step/ }).click();
    const st = page.locator('.editor-step').nth(i);
    await st.locator('.rte').click();
    await page.keyboard.type(text);
    await st.getByRole('switch', { name: 'Text Only Step' }).check();
  }
  await page.getByRole('button', { name: /Save As Draft/ }).click();
  await settle(page);
  await page.getByRole('button', { name: /Finish & Submit/ }).click();
  await expect(page).toHaveURL(/\/sops\/[0-9a-f-]+(\?.*)?$/);
  const sop2Url = new URL(page.url()).pathname;

  // Pre Approver sends the checklist SOP back; the die change goes through pre-approval and approval
  const ap = approver.page;
  await pre.goto(sop2Url);
  await settle(pre);
  await pre.getByPlaceholder(/Comment/).fill('Please add a step for checking the seat belt.');
  await pre.getByRole('button', { name: 'Reject', exact: true }).click();
  await settle(pre);
  await approveAndPublish(pre, sopUrl);
  await page.goto(sopUrl);
  await settle(page);
  await shot(page, '18b-sop-pre-approved', { full: true });
  await approveAndPublish(ap, sopUrl);

  // Editor: rejected SOP, fix and resubmit
  await page.goto(sop2Url);
  await settle(page);
  await shot(page, '19-sop-rejected', { full: true });
  await page.getByRole('link', { name: /Edit draft/ }).click();
  await expect(page).toHaveURL(/\/edit\//);
  await settle(page);
  await page.getByRole('button', { name: /Add New Step/ }).click();
  const last = page.locator('.editor-step').last();
  await last.locator('.rte').click();
  await page.keyboard.type('Check that the seat belt latches and releases.');
  await last.getByRole('switch', { name: 'Text Only Step' }).check();
  await page.getByRole('button', { name: /Finish & Submit/ }).click();
  await expect(page).toHaveURL(/\/sops\/[0-9a-f-]+(\?.*)?$/);
  await approveAndPublish(pre, sop2Url);
  await approveAndPublish(ap, sop2Url);

  // Editor: published SOP
  await page.goto(sopUrl);
  await settle(page);
  await shot(page, '20-sop-published', { full: true });
  await part(page, page.locator('.opt-card').filter({ hasText: 'View or Print Options' }), '21-sop-view-print');
  await part(page, page.locator('.opt-card').filter({ hasText: 'Share Options' }), '22-sop-share');

  await page.goto(sopUrl.replace('/sops/', '/kiosk/'));
  await settle(page);
  await shot(page, '23-kiosk');

  await page.goto('/sops');
  await settle(page);
  await shot(page, '24-sops-grid');
  await page.getByRole('button', { name: 'List view' }).click();
  await settle(page);
  await shot(page, '25-sops-list');
  await page.getByRole('button', { name: 'Grid view' }).click();
  await page.getByRole('button', { name: 'Filter' }).click();
  await settle(page);
  await shot(page, '26-sops-filter');
  await page.goto('/sops');
  await settle(page);
  await page.getByRole('button', { name: 'Actions for Changeover of die set on press line 2' }).click();
  await settle(page);
  await shot(page, '27-sop-card-menu');

  // Training record from the card menu
  await page.getByRole('button', { name: 'Update Training Record' }).click();
  await settle(page);
  await page.locator('#tr-associate').selectOption({ label: 'Sam Operator' });
  await page.locator('#tr-level').selectOption({ index: 3 });
  await page.locator('#tr-notes').fill('Completed under supervision on line 2.');
  await shot(page, '28-training-record');
  await page.locator('form button[type=submit]').last().click();
  await settle(page);

  // Edit a published SOP → new draft version
  await page.goto(sopUrl);
  await settle(page);
  await page.getByRole('button', { name: /^Edit$/ }).first().click();
  await expect(page).toHaveURL(/\/edit\//);
  await settle(page);
  await page.getByRole('button', { name: /Save As Draft/ }).click();
  await settle(page);
  await page.goto(sopUrl);
  await settle(page);
  await shot(page, '29-sop-new-draft', { full: true });
  await page.getByRole('button', { name: 'More options' }).first().click();
  await page.getByRole('button', { name: 'Change History' }).first().click();
  await settle(page);
  await shot(page, '30-change-history');
  await page.keyboard.press('Escape');

  // ── Checklist run ──
  await page.goto(sop2Url);
  await settle(page);
  await page.getByRole('button', { name: 'Start checklist' }).click();
  await expect(page).toHaveURL(/\/checklists\//);
  await settle(page);
  await shot(page, '31-checklist-run');
  const okButtons = page.getByRole('button', { name: 'OK', exact: true });
  const n = await okButtons.count();
  for (let i = 0; i < n; i++) await okButtons.nth(i).click();
  await settle(page);
  await shot(page, '32-checklist-answered', { full: true });
  await page.getByRole('button', { name: 'Complete checklist' }).click();
  await settle(page);
  await page.goto('/checklists');
  await settle(page);
  await shot(page, '33-checklists');

  // ── Folders ──
  await page.goto('/folders');
  await settle(page);
  await shot(page, '40-folders');
  await page.getByPlaceholder('New folder name').fill('Press line 2');
  const parent = page.getByLabel('Parent folder');
  await parent.selectOption((await parent.locator('option', { hasText: 'Assembly' }).first().getAttribute('value'))!);
  await page.getByRole('button', { name: 'Create folder' }).click();
  await settle(page);
  await shot(page, '42-folders-tree');

  // ── Kanbans ──
  await page.goto('/kanbans');
  await settle(page);
  await shot(page, '50-kanbans-empty');
  await page.getByRole('link', { name: /Create New/ }).click();
  await expect(page).toHaveURL(/\/kanbans\/new/);
  await settle(page);
  await shot(page, '51-kanban-new', { full: true });
  await page.locator('form input[type=file]').first().setInputFiles({ name: 'bearing.png', mimeType: 'image/png', buffer: imgPart });
  await page.locator('#k-partDescription').fill('Ball bearing 20x47x14');
  await page.locator('#k-orderingUrl').fill('https://shop.example.com/6204');
  await page.locator('#k-usedFor').fill('Conveyor drive roller');
  await page.locator('#k-supplierPartNo').fill('6204-2RSH');
  await page.locator('#k-partCode').fill('BRG-6204');
  await page.locator('#k-supplier').fill('SKF');
  await page.locator('#k-orderWhen').fill('2 left');
  await page.locator('#k-orderQty').fill('10');
  await page.locator('#k-deliveryTime').fill('3 days');
  await page.locator('#k-location').fill('Rack A3');
  await page.locator('#k-tag').fill('bearings');
  await page.locator('#k-tag').press('Enter');
  await settle(page);
  await shot(page, '52-kanban-filled', { full: true });
  await page.getByRole('button', { name: /Save draft/ }).first().click();
  await expect(page).toHaveURL(/\/kanbans$/);
  await settle(page);
  await page.goto('/approvals');
  await settle(page);
  await page.getByRole('button', { name: /^Mine/ }).click();
  await settle(page);
  await shot(page, '53a-approvals-mine');
  await page.getByRole('link', { name: 'Open' }).first().click();
  await page.waitForURL(/\/approvals\/kanban\//);
  await settle(page);
  await shot(page, '53-kanban-draft');
  const revisionUrl = new URL(page.url()).pathname;
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await settle(page);
  await shot(page, '54-kanban-submitted');
  await approveAndPublish(pre, revisionUrl);
  await approveAndPublish(ap, revisionUrl);
  await page.goto('/kanbans');
  await settle(page);
  await shot(page, '55-kanbans-list');
  await page.locator('.kanban-card').filter({ hasText: 'BRG-6204' }).first().click();
  await page.waitForURL(/\/kanbans\/[0-9a-f-]+$/);
  await settle(page);
  await shot(page, '56-kanban-detail', { full: true });
  const kanbanUrl = new URL(page.url()).pathname;
  await page.goto('/kanbans');
  await settle(page);
  await page.getByRole('button', { name: 'Actions for BRG-6204' }).click();
  await settle(page);
  await shot(page, '57-kanban-card-menu');

  // Changing a live card: Edit → Save draft → Submit for review on the card page
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.waitForURL(/\/edit$/);
  await settle(page);
  await page.locator('#k-orderQty').fill('20');
  await page.getByRole('button', { name: /Save draft/ }).first().click();
  await page.waitForURL(/\/kanbans\/[0-9a-f-]+$/);
  await settle(page);
  await shot(page, '58-kanban-change-draft', { full: true });
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await settle(page);
  await shot(page, '59-kanban-change-submitted', { full: true });
  await approveAndPublish(pre, kanbanUrl);
  await approveAndPublish(ap, kanbanUrl);

  // ── Skills, analytics, search, profile ──
  await page.goto('/skills');
  await settle(page);
  await shot(page, '60-skills');
  await page.goto('/analytics');
  await settle(page);
  await shot(page, '61-analytics', { full: true });
  await page.getByPlaceholder(/Search SOPs, kanbans/).fill('die');
  await page.getByPlaceholder(/Search SOPs, kanbans/).press('Enter');
  await page.waitForURL(/\/search/);
  await page.getByText('Searching…').waitFor({ state: 'hidden' });
  await settle(page);
  await shot(page, '62-search');
  await page.goto('/profile');
  await settle(page);
  await shot(page, '63-profile', { full: true });
  await page.goto('/approvals');
  await settle(page);
  await shot(page, '64-approvals-done');
});

/** Renders docs/user-guide/index.html to the PDF that its "Download PDF" button links to. Runs after the screenshots. */
test('@guide render the user guide PDF', async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(path.resolve(__dirname, '../../docs/user-guide/index.html')).href);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({ path: '../docs/user-guide/SAWO-Playbook-Editor-Guide.pdf', preferCSSPageSize: true, printBackground: true });
  await page.close();
});
