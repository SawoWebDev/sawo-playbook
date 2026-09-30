/** KANBANS UI: bulk import (validation errors, all-or-nothing, success), search, selection + bulk edit, single create. */
import { expect, test } from '@playwright/test';
import { email, newUserContext, signup } from './helpers';

test('bulk import, filter, bulk edit and create a card', async ({ browser }) => {
  const { context, page } = await newUserContext(browser);
  await signup(page, 'Kanban Co', 'Kim Kanban', email('kanban-owner'));
  await page.goto('/kanbans');
  await expect(page.getByText('No kanban cards found.')).toBeVisible();

  // Invalid CSV: row-level errors, nothing imported
  await page.getByRole('button', { name: 'Bulk import' }).click();
  const box = page.getByPlaceholder('…or paste CSV here');
  await box.fill('part_code,ordering_type,ordering_email\nGOOD-1,email,buyer@example.com\n,email,buyer@example.com\nBAD-2,email,not-an-email\n');
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByText('Row 3: part_code is required')).toBeVisible();
  await expect(page.getByText('Row 4: A valid ordering email is required')).toBeVisible();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByText('Row 3: part_code is required')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('No kanban cards found.')).toBeVisible();

  // Valid CSV
  await page.getByRole('button', { name: 'Bulk import' }).click();
  await page.getByPlaceholder('…or paste CSV here').fill(
    [
      'part_code,part_description,supplier,location,ordering_type,ordering_url,ordering_email,tag',
      'BRG-6204,Ball bearing,SKF,Rack A3,url,https://shop.example.com/6204,,bearings',
      'BRG-6205,Ball bearing large,SKF,Rack A4,url,https://shop.example.com/6205,,bearings',
      'FLT-100,Hydraulic filter,Parker,Bin 7,email,,stores@example.com,filters',
    ].join('\n'),
  );
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByText('3 rows are valid and ready to import.')).toBeVisible();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByText('3 kanban cards imported.')).toBeVisible();
  await expect(page.locator('.kanban-card')).toHaveCount(3);

  // Search + facet filter
  await page.getByPlaceholder('Search part, supplier, tag…').fill('parker');
  await expect(page.locator('.kanban-card')).toHaveCount(1);
  await expect(page.locator('.kanban-card')).toContainText('FLT-100');
  await page.getByPlaceholder('Search part, supplier, tag…').fill('');
  await page.locator('select').filter({ hasText: 'All tags' }).selectOption('bearings');
  await expect(page.locator('.kanban-card')).toHaveCount(2);
  await page.locator('select').filter({ hasText: 'All tags' }).selectOption('');
  await expect(page.locator('.kanban-card')).toHaveCount(3);

  // Select two cards → bulk edit location
  const cards = page.locator('.kanban-card');
  await cards.filter({ hasText: 'BRG-6204' }).locator('input[type=checkbox]').check();
  await cards.filter({ hasText: 'BRG-6205' }).locator('input[type=checkbox]').check();
  await expect(page.getByText('2 selected')).toBeVisible();
  await page.getByRole('button', { name: 'Bulk edit' }).click();
  await page.getByLabel('Location').fill('Rack Z9');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('2 cards updated.')).toBeVisible();
  await expect(cards.filter({ hasText: 'Rack Z9' })).toHaveCount(2);

  // Create a single card; ordering target validation
  await page.getByRole('button', { name: '+ New card' }).click();
  await page.getByLabel('Part code *').fill('SEAL-42');
  await page.getByLabel('Part description').fill('Piston seal kit');
  await page.locator('.dialog select').filter({ hasText: 'Web link' }).selectOption('email');
  await page.getByPlaceholder('purchasing@example.com').fill('purchasing@example.com');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(cards).toHaveCount(4);
  await expect(cards.filter({ hasText: 'SEAL-42' }).getByRole('link', { name: 'Email order' })).toHaveAttribute('href', /^mailto:purchasing@example\.com/);
  await context.close();
});
