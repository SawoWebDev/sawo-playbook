/** Two-factor authentication through the UI: enrol from Profile, then sign in with a code. */
import { expect, test } from '@playwright/test';
import { email, login, logout, newUserContext, signup, totp } from './helpers';

test('enable 2FA from profile, then login requires a valid code', async ({ browser }) => {
  const { context, page } = await newUserContext(browser);
  const mail = email('mfa-owner');
  await signup(page, 'MFA Co', 'Max Mfa', mail);

  await page.goto('/profile');
  await page.getByRole('button', { name: 'Set up two-factor authentication' }).click();
  await expect(page.getByRole('img', { name: 'MFA QR code' })).toBeVisible();
  const secret = (await page.locator('code').first().textContent())!.trim();
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);

  // wrong code is rejected with a visible error
  await page.getByPlaceholder('6-digit code').fill('000000');
  await page.getByRole('button', { name: 'Verify & enable' }).click();
  await expect(page.locator('.error')).toContainText('Invalid authentication code');

  await page.getByPlaceholder('6-digit code').fill(totp(secret));
  await page.getByRole('button', { name: 'Verify & enable' }).click();
  await expect(page.getByText('Two-factor authentication enabled.')).toBeVisible();
  await expect(page.locator('.badge', { hasText: 'Enabled' })).toBeVisible();

  // the rotated session still works after reload
  await page.reload();
  await expect(page.locator('.badge', { hasText: 'Enabled' })).toBeVisible();

  await logout(page);
  await login(page, mail);
  await expect(page.getByLabel('Authentication code')).toBeVisible();
  await page.getByLabel('Authentication code').fill('123456');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.locator('.error')).toContainText('Invalid authentication code');

  // next time-step code (the current step was consumed at enrolment)
  await page.getByLabel('Authentication code').fill(totp(secret, 1));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome, Max Mfa' })).toBeVisible();

  // admin view shows 2FA on
  await page.goto('/users');
  await expect(page.getByRole('row', { name: new RegExp(mail) }).locator('.badge', { hasText: 'on' })).toBeVisible();
  await context.close();
});
