/** Authentication UI: signup, login/logout, validation and error states, session restore, route protection. */
import { expect, test } from '@playwright/test';
import { email, login, logout, mailTo, newUserContext, PASSWORD, signup } from './helpers';

test('signup → logout → login; session survives a page reload (refresh cookie)', async ({ browser }) => {
  const { context, page } = await newUserContext(browser);
  const mail = email('auth-owner');
  await signup(page, 'Auth Test Co', 'Ava Auth', mail);
  await page.reload();
  await expect(page.getByRole('link', { name: /^STD OPS/ })).toBeVisible();
  await logout(page);
  await page.goto('/sops');
  await expect(page).toHaveURL(/\/login/);

  await login(page, mail);
  await expect(page.getByRole('link', { name: /^STD OPS/ })).toBeVisible();
  await context.close();
});

test('login and signup show validation / error states', async ({ browser }) => {
  const { context, page } = await newUserContext(browser);
  const mail = email('auth-dupe');
  await signup(page, 'Dupe Co', 'Dee Dupe', mail);
  await logout(page);

  await login(page, mail, 'definitely-wrong-password');
  await expect(page.locator('.error')).toHaveText('Invalid credentials');
  await expect(page).toHaveURL(/\/login/);

  await page.goto('/signup');
  await page.getByLabel('Organization name').fill('Another Co');
  await page.getByLabel('Your name').fill('Dee Again');
  await page.getByLabel('Email').fill(mail);
  await page.getByLabel('Password (min. 10 characters)').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.locator('.error')).toContainText('already exists');

  // HTML5 validation blocks short passwords before any request
  await page.getByLabel('Password (min. 10 characters)').fill('short');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(/\/signup/);
  expect(await page.getByLabel('Password (min. 10 characters)').evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(false);
  await context.close();
});

test('forgot password sends a reset email; reset link sets a new password', async ({ browser }) => {
  const { context, page } = await newUserContext(browser);
  const mail = email('auth-reset');
  await signup(page, 'Reset Co', 'Rita Reset', mail);
  await logout(page);

  await page.getByRole('link', { name: 'Forgot password?' }).click();
  await expect(page.getByRole('heading', { name: 'Reset password' })).toBeVisible();
  await page.getByLabel('Email').fill(mail);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByText('If an account exists for that email')).toBeVisible();

  const msg = await mailTo(mail);
  const m = msg?.Text.match(/\/reset-password\/([A-Za-z0-9_-]+)/);
  expect(m).toBeTruthy();
  await page.goto(`/reset-password/${m![1]}`);
  await page.getByLabel(/New password/).fill('a-brand-new-password-1');
  await page.getByRole('button', { name: 'Update password' }).click();
  await expect(page.getByText('Password updated.')).toBeVisible();

  await login(page, mail, PASSWORD);
  await expect(page.locator('.error')).toHaveText('Invalid credentials');
  await login(page, mail, 'a-brand-new-password-1');
  await expect(page.getByRole('link', { name: /^STD OPS/ })).toBeVisible();
  await context.close();
});

test('login ?next= only follows same-origin paths', async ({ browser }) => {
  const { context, page } = await newUserContext(browser);
  const mail = email('auth-next');
  await signup(page, 'Next Co', 'Nate Next', mail);
  await logout(page);
  await page.goto('/login?next=//evil.example.com/steal');
  await page.getByLabel('Email').fill(mail);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('link', { name: /^STD OPS/ })).toBeVisible();
  expect(new URL(page.url()).host).not.toContain('evil');
  await context.close();
});
