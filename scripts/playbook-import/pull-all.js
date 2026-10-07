const fs = require('fs');
const path = require('path');
const { launch, login, dump, BASE_URL } = require('./lib');

const OUT_DIR = path.join(__dirname, 'output');
const IMG_DIR = path.join(OUT_DIR, 'images');
const CARD_LINK_SEL = 'a.stdops_anchur[href^="https"]';

// `node pull-all.js --limit=2` for a small test run.
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || Infinity;
// `node pull-all.js --url=<href>` to retry a single SOP directly, skipping the list scroll.
const ONLY_URL = (process.argv.find((a) => a.startsWith('--url=')) || '').slice(6) || null;

function parseCardText(text) {
  const get = (label) => {
    const m = text.match(new RegExp(`${label}:\\s*(.+)`));
    return m ? m[1].trim() : null;
  };
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return {
    title: lines[0] || null,
    referenceNo: get('Reference No'),
    folder: get('Folder'),
    dateRaised: get('Date Raised'),
    createdBy: get('Created By'),
    lastModified: get('Last Modified'),
  };
}

async function collectSops(page) {
  const found = new Map(); // href -> card data
  let stagnantRounds = 0;

  for (let round = 0; round < 60 && stagnantRounds < 4 && found.size < LIMIT; round++) {
    const cards = await page.$$eval(CARD_LINK_SEL, (as) =>
      as.map((a) => ({ href: a.getAttribute('href'), text: a.innerText })),
    );
    for (const c of cards) if (!found.has(c.href)) found.set(c.href, parseCardText(c.text));

    const before = found.size;
    await page.mouse.wheel(0, 3000);
    await page.waitForTimeout(400);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(400);

    const cardsAfter = await page.$$eval(CARD_LINK_SEL, (as) =>
      as.map((a) => ({ href: a.getAttribute('href'), text: a.innerText })),
    );
    for (const c of cardsAfter) if (!found.has(c.href)) found.set(c.href, parseCardText(c.text));

    stagnantRounds = found.size === before ? stagnantRounds + 1 : 0;
  }

  return [...found.entries()].slice(0, LIMIT).map(([href, data]) => ({ href, ...data }));
}

async function extractDetail(page) {
  const formField = async (label) => {
    const loc = page.locator('label.form-lable', { hasText: label }).first();
    if (!(await loc.isVisible({ timeout: 2000 }).catch(() => false))) return null;
    const val = await loc.locator('xpath=following-sibling::p[contains(@class,"formAns")][1]').innerText().catch(() => null);
    return val?.trim() || null;
  };

  const configToggle = async (title) => {
    const card = page.locator('.sop-config-card', { has: page.locator('h6', { hasText: title }) }).first();
    if (!(await card.isVisible({ timeout: 2000 }).catch(() => false))) return null;
    const onBadge = await card.locator('.badge-on').count();
    return onBadge > 0;
  };

  const name = await formField('Procedure Name');
  const createdBy = await formField('Created By');
  const checklistSop = await configToggle('Checklist SOP');
  const coverSheet = await configToggle('Cover Sheet');

  // A SOP can genuinely have zero steps ("No step found." shown instead of a step grid).
  // Poll for either condition instead of waiting a fixed 20s on a locator that will never
  // appear for a legitimately-empty SOP.
  let hasSteps = false;
  for (let waited = 0; waited < 20_000; waited += 500) {
    const [stepCount, noStepFound] = await page.evaluate(() => [
      document.querySelectorAll('.load_step_records .step-num').length,
      document.body.textContent.includes('No step found'),
    ]);
    if (stepCount > 0) {
      hasSteps = true;
      break;
    }
    if (noStepFound) {
      hasSteps = false;
      break;
    }
    await page.waitForTimeout(500);
  }

  const stepCards = page.locator('.load_step_records .view__sop__img:has(.step-num)');
  const stepCount = hasSteps ? await stepCards.count() : 0;
  const steps = [];

  for (let i = 0; i < stepCount; i++) {
    const card = stepCards.nth(i);
    const stepLabel = await card.locator('.step-num').innerText({ timeout: 5000 }).catch(() => `Step ${i + 1}`);
    const imageSrc = await card.locator('img.stdopImage').first().getAttribute('src', { timeout: 5000 }).catch(() => null);
    const plannedTime = await card.locator('.video-total-time-badge').first().innerText({ timeout: 5000 }).catch(() => null);
    const descRaw = await card.locator('.view-step-desc').innerText({ timeout: 5000 }).catch(() => '');
    const description = descRaw.replace(/^\s*\d+\.\)\s*/, '').trim();

    steps.push({ order: i + 1, stepLabel: stepLabel.trim(), imageSrc, plannedTime, description });
  }

  return { name, createdBy, config: { checklist_sop: checklistSop, cover_sheet: coverSheet }, steps };
}

async function downloadImage(page, url, destPath) {
  if (!url) return null;
  const resp = await page.context().request.get(url, { timeout: 15_000 });
  if (!resp.ok()) return null;
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, await resp.body());
  return destPath;
}

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`[watchdog] ${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function slugify(s) {
  return (s || 'sop')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60);
}

async function processOne(page, card, idx) {
  await page.goto(card.href, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  console.log('  [nav] loaded, extracting...');
  await page.locator('label.form-lable', { hasText: 'Procedure Name' }).first().waitFor({ state: 'visible', timeout: 15_000 });
  const detail = await extractDetail(page);
  console.log(`  [extract] name="${detail.name}" steps=${detail.steps.length}`);
  // Some SOPs genuinely share the same real name (e.g. several are literally titled "N/A" on
  // gembadocs.com itself) — append a short id from the URL so same-named SOPs don't collide
  // and overwrite each other's file.
  const urlId = card.href.match(/view-standard-operation\/([^/?]+)/)?.[1]?.split('-').pop() ?? String(idx + 1);
  const baseSlug = slugify(detail.name || card.title) || 'sop';
  const slug = `${baseSlug}-${urlId}`;

  for (const step of detail.steps) {
    if (step.imageSrc) {
      const ext = path.extname(step.imageSrc.split('?')[0]) || '.jpg';
      const dest = path.join(IMG_DIR, slug, `step-${step.order}${ext}`);
      step.localImagePath = await downloadImage(page, step.imageSrc, dest).catch((e) => {
        console.log(`  [img] FAILED step ${step.order}: ${e.message}`);
        return null;
      });
      console.log(`  [img] step ${step.order} -> ${step.localImagePath ? 'ok' : 'failed'}`);
    }
  }

  const record = { sourceUrl: card.href, list: card, ...detail };
  fs.writeFileSync(path.join(OUT_DIR, `${slug}.json`), JSON.stringify(record, null, 2), 'utf8');
  return { href: card.href, slug, name: detail.name, stepCount: detail.steps.length, status: 'ok' };
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { browser, page } = await launch();
  const manifest = [];

  try {
    console.log('[pull-all] logging in...');
    await login(page);

    let cards;
    if (ONLY_URL) {
      cards = [{ href: ONLY_URL, title: 'retry' }];
      console.log(`[pull-all] retry mode: single SOP ${ONLY_URL}`);
    } else {
      console.log('[pull-all] navigating to STD OPS...');
      await page.goto(new URL('/front-dashboard?tab=stdop', BASE_URL).toString(), { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.locator(CARD_LINK_SEL).first().waitFor({ state: 'visible', timeout: 20_000 });

      console.log('[pull-all] collecting SOP cards (scrolling)...');
      cards = await collectSops(page);
      console.log(`[pull-all] found ${cards.length} SOP(s)${LIMIT !== Infinity ? ` (limit=${LIMIT})` : ''}`);
    }

    // Match by sourceUrl, not a title-derived slug guess: list card titles can render as a
    // transient placeholder ("N/A") during scroll-loading, which would make every such card
    // collide on the same guessed slug and falsely skip real, distinct SOPs.
    const existingBySourceUrl = new Map();
    for (const f of fs.readdirSync(OUT_DIR)) {
      if (!f.endsWith('.json') || f === 'manifest.json') continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), 'utf8'));
        if (data.sourceUrl) existingBySourceUrl.set(data.sourceUrl, f.replace(/\.json$/, ''));
      } catch {}
    }

    for (const [idx, card] of cards.entries()) {
      const existingSlug = existingBySourceUrl.get(card.href);
      if (existingSlug) {
        console.log(`[pull-all] (${idx + 1}/${cards.length}) ${card.title} -> already pulled, skipping`);
        manifest.push({ href: card.href, slug: existingSlug, name: card.title, status: 'ok' });
        continue;
      }
      console.log(`[pull-all] (${idx + 1}/${cards.length}) ${card.title} -> ${card.href}`);
      try {
        const result = await withTimeout(processOne(page, card, idx), 150_000, `SOP ${idx + 1}`);
        manifest.push(result);
      } catch (err) {
        console.error(`[pull-all] FAILED ${card.href}: ${err.message}`);
        manifest.push({ href: card.href, status: 'error', error: err.message });
      }
      await page.waitForTimeout(1200 + Math.random() * 800); // pacing: avoid hammering their server
    }

    let finalManifest = manifest;
    const manifestPath = path.join(OUT_DIR, 'manifest.json');
    if (ONLY_URL && fs.existsSync(manifestPath)) {
      const prev = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).filter((m) => m.href !== ONLY_URL);
      finalManifest = [...prev, ...manifest];
    }
    fs.writeFileSync(manifestPath, JSON.stringify(finalManifest, null, 2), 'utf8');
    console.log(`[pull-all] done. ${manifest.filter((m) => m.status === 'ok').length}/${manifest.length} succeeded.`);
  } catch (err) {
    console.error('[pull-all] fatal:', err.message);
    await dump(page, 'pull-all-fatal').catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
