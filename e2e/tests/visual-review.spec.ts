/**
 * @review — screenshot tour for the manual visual/layout pass (not part of CI).
 * Run: docker compose --profile e2e run --rm -e E2E_ARGS="--grep @review" e2e
 * Output: e2e/review/<viewport>-<page>.png
 */
import { expect, Page, test } from '@playwright/test';
import { email, newUserContext, PNG, RUN, signup } from './helpers';

test.skip(!process.env.E2E_REVIEW, 'visual review tour runs only with E2E_REVIEW=1');

const shot = (page: Page, name: string) => page.screenshot({ path: `review/${name}.png`, fullPage: true });

test('@review screenshot tour (desktop + mobile)', async ({ browser }) => {
  const { context, page } = await newUserContext(browser);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/login');
  await shot(page, 'desktop-login');
  await signup(page, `Acme Plant ${RUN}`, 'Vera Visual', email('visual'));
  await shot(page, 'desktop-home');

  // content
  await page.goto('/folders');
  await page.getByPlaceholder('New folder name').fill('Assembly');
  await page.getByRole('button', { name: 'Create folder' }).click();
  await page.goto('/sops');
  await page.getByRole('button', { name: '+ Create New' }).click();
  await shot(page, 'desktop-sops-create-menu');
  await page.getByRole('button', { name: 'Advanced SOP' }).click();
  await page.getByLabel('Procedure name').fill('Changeover of die set on press line 2');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page).toHaveURL(/\/edit\//);
  const steps = [
    ['Isolate', 'Apply <b>lock-out / tag-out</b> to the main isolator and verify zero energy.', true],
    ['Remove die', 'Loosen the four clamp bolts and lift the die with the approved hoist.', false],
    ['Fit new die', 'Align the locating pins, torque clamp bolts to 120 Nm in a cross pattern.', false],
  ] as const;
  for (const [i, [title, text, critical]] of steps.entries()) {
    await page.getByRole('button', { name: '+ Add New Step' }).click();
    const s = page.locator('.editor-step').nth(i);
    await s.getByPlaceholder('Step title').fill(title);
    await s.locator('.rte').click();
    await page.keyboard.type(text.replace(/<\/?b>/g, ''));
    await s.getByPlaceholder('HH:MM:SS').fill('00:0' + (i + 1) + ':00');
    await s.getByPlaceholder('HH:MM:SS').press('Tab');
    if (critical) await s.getByLabel('Is this step critical?').check();
    if (i === 0) await s.locator('input[type=file]').first().setInputFiles({ name: 'loto.png', mimeType: 'image/png', buffer: PNG });
  }
  await shot(page, 'desktop-sop-editor');
  await page.getByRole('button', { name: 'Finish & Save' }).click();
  await expect(page).toHaveURL(/\/sops\/[0-9a-f-]+$/);
  await expect(page.locator('.badge', { hasText: 'Published' }).first()).toBeVisible();
  await shot(page, 'desktop-sop-detail');
  const sopUrl = new URL(page.url()).pathname;

  await page.goto('/sops');
  await shot(page, 'desktop-sops-list');

  await page.goto('/kanbans');
  await page.getByRole('button', { name: 'Bulk import (CSV)' }).click();
  await page
    .getByPlaceholder('…or paste CSV here')
    .fill(
      'part_code,part_description,supplier,location,order_qty,order_when,ordering_type,ordering_url,ordering_email,tag,color\n' +
        'BRG-6204,Ball bearing 20x47x14,SKF,Rack A3,10,2 left,url,https://shop.example.com/6204,,bearings,#1f5fbf\n' +
        'FLT-100,Hydraulic return filter 10µm,Parker,Bin 7,2,1 left,email,,stores@example.com,filters,#1a7f37\n' +
        'SEAL-42,Piston seal kit,Hallite,Rack C1,5,2 left,email,,stores@example.com,seals,#b42318\n',
    );
  await shot(page, 'desktop-kanban-import');
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.locator('.kanban-card')).toHaveCount(3);
  await shot(page, 'desktop-kanbans');

  for (const [path, name] of [
    ['/folders', 'folders'],
    ['/skills', 'skills'],
    ['/users', 'users'],
    ['/settings', 'settings'],
    ['/analytics', 'analytics'],
    ['/audit', 'audit'],
    ['/profile', 'profile'],
    ['/checklists', 'checklists'],
  ] as const) {
    await page.goto(path);
    await expect(page.locator('h1').first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    await shot(page, `desktop-${name}`);
  }
  await page.goto(sopUrl.replace('/sops/', '/kiosk/'));
  await page.goto(sopUrl); // kiosk needs a published version; capture its empty state via detail instead

  // Phone width
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [path, name] of [
    ['/', 'home'],
    ['/sops', 'sops-list'],
    [sopUrl, 'sop-detail'],
    ['/kanbans', 'kanbans'],
    ['/users', 'users'],
    ['/skills', 'skills'],
  ] as const) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    await shot(page, `mobile-${name}`);
  }
  await context.close();

  const anon = await newUserContext(browser);
  await anon.page.setViewportSize({ width: 390, height: 844 });
  await anon.page.goto('/login');
  await shot(anon.page, 'mobile-login');
  await anon.context.close();
});
