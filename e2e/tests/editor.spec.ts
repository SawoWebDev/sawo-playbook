/**
 * SOP editor (reference layout) and the default no-approval process:
 * Save As Draft keeps editing; Finish & Save publishes immediately.
 */
import { expect, test } from '@playwright/test';
import { email, newUserContext, PNG, RUN, signup } from './helpers';

test('create → Save As Draft → Finish & Save publishes without approval → edit again', async ({ browser }) => {
  const { context, page } = await newUserContext(browser);
  await signup(page, `Door Plant ${RUN}`, 'Ella Editor', email('editor-owner'));

  await page.goto('/sops');
  await page.getByRole('button', { name: '+ Create New' }).click();
  await page.getByRole('button', { name: 'Standard SOP' }).click();
  await page.getByLabel('Procedure name').fill('Proper Handling and Care of Doors');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page).toHaveURL(/\/edit\//);

  // Header and configuration match the reference layout
  await expect(page.getByText('Edit Standard Operation')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save As Draft' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Finish & Save' })).toBeVisible();
  await expect(page.getByText('33/100')).toBeVisible();
  for (const label of ['Cover Sheet', 'Checklist SOP', 'Advanced SOP']) await expect(page.getByLabel(label)).not.toBeChecked();

  // Step 1: photo, description, planned time HH:MM:SS
  await page.getByRole('button', { name: '+ Add New Step' }).click();
  const s1 = page.locator('.editor-step').nth(0);
  await expect(s1.getByText('STEP 1')).toBeVisible();
  await expect(s1.getByRole('button', { name: /Add photo/ })).toBeVisible();
  await s1.locator('input[type=file]').first().setInputFiles({ name: 'ppe.png', mimeType: 'image/png', buffer: PNG });
  await expect(s1.locator('.media-main img')).toHaveCount(1);
  await s1.locator('.rte').click();
  await page.keyboard.type('Wear required PPE, remove hand accessories, and ensure hands are clean.');
  await expect(s1.locator('.desc-count')).toHaveText('71');
  await expect(s1.getByText('more characters may make the text appear')).toHaveCount(0);
  await s1.getByPlaceholder('HH:MM:SS').fill('00:00:11');
  await s1.getByPlaceholder('HH:MM:SS').press('Tab');

  // Insert Step below step 1, then long text shows the PDF-length hint
  await page.getByRole('button', { name: '+ Insert Step' }).first().click();
  const s2 = page.locator('.editor-step').nth(1);
  await expect(s2.getByText('STEP 2')).toBeVisible();
  await s2.locator('.rte').click();
  await page.keyboard.type(
    'Before lifting, inspect the door for existing damage, scratches, or contamination, and if any is found, tag and set it aside for supervisor review.',
  );
  await expect(s2.getByText('more characters may make the text appear less than optimal in some PDF formats')).toBeVisible();
  await s2.getByLabel('Is this step critical?').check();
  await expect(page.getByText('Cycle time 11s')).toBeVisible();

  // Move Up swaps the steps
  await page.getByRole('button', { name: '↑ Move Up' }).nth(1).click();
  await expect(page.locator('.editor-step').nth(0).locator('.rte')).toContainText('Before lifting');
  await page.getByRole('button', { name: '↓ Move Down' }).first().click();
  await expect(page.locator('.editor-step').nth(0).locator('.rte')).toContainText('Wear required PPE');

  // Save As Draft: stays in the editor, shows confirmation
  await page.getByRole('button', { name: 'Save As Draft' }).click();
  await expect(page.getByText('Draft saved.')).toBeVisible();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.getByLabel('Saved')).toBeVisible();

  // Finish & Save: published directly, no approval step anywhere
  await page.getByRole('button', { name: 'Finish & Save' }).click();
  await expect(page).toHaveURL(/\/sops\/[0-9a-f-]+$/);
  await expect(page.locator('.badge', { hasText: 'Published' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit for approval' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Approvals' })).toHaveCount(0);
  await expect(page.getByText('2 steps')).toBeVisible();
  await expect(page.getByRole('img', { name: 'QR code' })).toBeVisible();

  // Edit again → version 1.002 in the editor; Cancel returns without publishing
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByText('v1.002 draft')).toBeVisible();
  await expect(page.locator('.editor-step')).toHaveCount(2);
  page.once('dialog', (d) => d.accept());
  await page.locator('.editor-step').nth(0).getByLabel('Text Only Step').check();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page).toHaveURL(/\/sops\/[0-9a-f-]+$/);
  await expect(page.getByText('Version 1.002')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Edit draft' })).toBeVisible();

  // Publish the draft from the SOP page (Publish button replaces Submit)
  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Version published.')).toBeVisible();
  await context.close();
});

test('description limit: over 400 characters blocks saving', async ({ browser }) => {
  const { context, page } = await newUserContext(browser);
  await signup(page, 'Limit Co', 'Lee Limit', email('editor-limit'));
  await page.goto('/sops');
  await page.getByRole('button', { name: '+ Create New' }).click();
  await page.getByRole('button', { name: 'Standard SOP' }).click();
  await page.getByLabel('Procedure name').fill('Long text');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('button', { name: '+ Add New Step' }).click();
  await page.locator('.rte').click();
  await page.keyboard.insertText('x'.repeat(401));
  await expect(page.locator('.desc-count')).toHaveText('401');
  await expect(page.getByText('Descriptions can be at most 400 characters.')).toBeVisible();
  await page.getByRole('button', { name: 'Save As Draft' }).click();
  await expect(page.locator('.error')).toContainText('longer than 400 characters');
  await context.close();
});
