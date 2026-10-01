import { Browser, BrowserContext, expect, Page } from '@playwright/test';
import { createHmac } from 'crypto';

export const PASSWORD = 'correct-horse-battery-staple';
export const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://localhost:8025';

let ipCounter = Math.floor(Math.random() * 200);

/** Unique run suffix so tests can be re-run against the same database. */
export const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
export const email = (who: string) => `${who}-${RUN}@e2e.test`;

/**
 * Each simulated person gets their own browser context and client IP
 * (X-Forwarded-For, honoured by the API's trusted-proxy setting), like real users.
 */
export async function newUserContext(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  ipCounter = (ipCounter + 1) % 250;
  const context = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': `198.51.100.${ipCounter + 1}` } });
  const page = await context.newPage();
  return { context, page };
}

export async function signup(page: Page, org: string, name: string, mail: string) {
  await page.goto('/signup');
  await page.getByLabel('Organization name').fill(org);
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Email').fill(mail);
  await page.getByLabel('Password (min. 10 characters)').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByRole("link", { name: /^STD OPS/ })).toBeVisible();
}

export async function login(page: Page, mail: string, password = PASSWORD) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(mail);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

export async function logout(page: Page) {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
}

/** Invites a user from Manage Users and returns the invitation path (/invite/<token>). */
export async function invite(page: Page, mail: string, roleLabel: string): Promise<string> {
  await page.goto('/users');
  await page.locator('#inv-email').fill(mail);
  await page.locator('#inv-role').selectOption({ label: roleLabel });
  await page.getByRole('button', { name: 'Send invitation', exact: true }).click();
  const notice = page.locator('.success', { hasText: 'Invitation sent' });
  await expect(notice).toBeVisible();
  const text = (await notice.textContent()) ?? '';
  const m = text.match(/\/invite\/([A-Za-z0-9_-]+)/);
  if (!m) throw new Error(`No invite link in: ${text}`);
  return `/invite/${m[1]}`;
}

export async function acceptInvite(page: Page, path: string, name: string) {
  await page.goto(path);
  await expect(page.getByRole('heading', { name: /^Join / })).toBeVisible();
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel(/Choose a password/).fill(PASSWORD);
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page.getByRole("link", { name: /^STD OPS/ })).toBeVisible();
}

/** Latest Mailpit message sent to `to`, if any. */
export async function mailTo(to: string): Promise<{ Subject: string; Text: string } | null> {
  for (let i = 0; i < 20; i++) {
    const r = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
    const list = (await r.json()) as { messages: { ID: string }[] };
    if (list.messages?.length) {
      const msg = await fetch(`${MAILPIT_URL}/api/v1/message/${list.messages[0].ID}`);
      return (await msg.json()) as { Subject: string; Text: string };
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  return null;
}

// ───────── TOTP (RFC 6238) for the 2FA flow ─────────

function base32Decode(s: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totp(secret: string, offsetSteps = 0): string {
  const step = Math.floor(Date.now() / 30_000) + offsetSteps;
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0x0f;
  return ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

// 1×1 PNG used for step and kanban images
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
