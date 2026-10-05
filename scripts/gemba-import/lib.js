require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE_URL = process.env.GEMBA_BASE_URL || 'https://gembadocs.com';
const EMAIL = process.env.GEMBA_EMAIL;
const PASSWORD = process.env.GEMBA_PASSWORD;
const HEADLESS = (process.env.HEADLESS ?? 'true') !== 'false';

function assertCreds() {
  if (!EMAIL || !PASSWORD) {
    throw new Error('Set GEMBA_EMAIL and GEMBA_PASSWORD in scripts/gemba-import/.env (copy from .env.example)');
  }
}

async function launch() {
  const browser = await chromium.launch({ headless: HEADLESS, channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  return { browser, context, page };
}

/** Best-effort login: tries a handful of common selector patterns. */
async function login(page) {
  assertCreds();
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

  const loginLink = page.getByText('Log In', { exact: true }).first();
  if (await loginLink.isVisible({ timeout: 3000 }).catch(() => false)) {
    await loginLink.click();
    await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
  }

  const emailCandidates = [
    'input[name="user_email"]',
    'input[type="email"]',
    'input[name="email"]',
    'input#email',
    'input[placeholder*="mail" i]',
  ];
  const passwordCandidates = [
    'input[type="password"]',
    'input[name="password"]',
    'input#password',
  ];
  const submitCandidates = [
    'button[type="submit"]',
    'button:has-text("Log in")',
    'button:has-text("Login")',
    'button:has-text("Sign in")',
  ];

  const emailInput = await firstVisible(page, emailCandidates);
  const passwordInput = await firstVisible(page, passwordCandidates);

  if (!emailInput || !passwordInput) {
    throw new Error('Could not find login form fields — see debug/login-page.png / .html');
  }

  await emailInput.fill(EMAIL);
  await passwordInput.fill(PASSWORD);

  const submitBtn = await firstVisible(page, submitCandidates);
  if (submitBtn) {
    await submitBtn.click();
  } else {
    await passwordInput.press('Enter');
  }

  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
}

async function firstVisible(page, selectors) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      if (await loc.isVisible({ timeout: 1000 })) return loc;
    } catch {
      /* not present, try next */
    }
  }
  return null;
}

async function dump(page, name, dir = path.join(__dirname, 'debug')) {
  fs.mkdirSync(dir, { recursive: true });
  const html = await page.content();
  fs.writeFileSync(path.join(dir, `${name}.html`), html, 'utf8');
  await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true }).catch(() => {});
  console.log(`[dump] ${name}: url=${page.url()}`);
}

module.exports = { BASE_URL, HEADLESS, launch, login, dump, firstVisible };
