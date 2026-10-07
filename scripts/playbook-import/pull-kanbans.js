// Pulls every kanban from gembadocs.com: list cards (dates, creator, colour, order) + each kanban's view page (all fields) + its picture.
// Output: output/kanbans/<id>.json, output/kanbans/images/<id>.<ext>, output/kanbans/manifest.json (list order, newest first).
// Resumable: kanbans already on disk (matched by sourceUrl) are skipped. Flags: --limit=N, --url=<view url> (retry one).
const fs = require('fs');
const path = require('path');
const { launch, login, BASE_URL } = require('./lib');

const OUT = path.join(__dirname, 'output', 'kanbans');
const IMG = path.join(OUT, 'images');
const CARD_SEL = 'a.stdops_anchur[href*="/view-kanban/"]';
const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=');
const LIMIT = Number(arg('limit')) || Infinity;
const ONLY_URL = arg('url') || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => (t = setTimeout(() => reject(new Error(`[watchdog] ${label} exceeded ${ms}ms`)), ms)));
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function sniffExt(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return '.png';
  if (b[0] === 0xff && b[1] === 0xd8) return '.jpg';
  if (b[0] === 0x47 && b[1] === 0x49) return '.gif';
  if (b.length > 11 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  return '.bin';
}

const idOf = (href) => (href.match(/\/view-kanban\/([^/?]+)/) || [])[1];

async function collectCards(page) {
  const found = new Map();
  let stagnant = 0;
  for (let round = 0; round < 300 && stagnant < 6 && found.size < LIMIT; round++) {
    const cards = await page.$$eval(CARD_SEL, (as) =>
      as.map((a) => {
        const card = a.closest('.card');
        const rows = {};
        a.querySelectorAll('.kanbanDetailList li').forEach((li) => {
          const lab = li.querySelector('label');
          if (lab) rows[lab.textContent.replace(/:\s*$/, '').trim()] = li.textContent.replace(lab.textContent, '').replace(/\s+/g, ' ').trim();
        });
        return {
          href: a.getAttribute('href'),
          title: (a.querySelector('h5')?.textContent || '').trim(),
          rows,
          color: ((card?.getAttribute('style') || '').match(/#[0-9a-fA-F]{3,8}/) || [null])[0],
          thumb: a.querySelector('.kanbanImg img')?.getAttribute('src') || null,
        };
      }),
    );
    const before = found.size;
    for (const c of cards) if (!found.has(c.href)) found.set(c.href, c);
    await page.mouse.wheel(0, 3500);
    await page.waitForTimeout(500);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(400);
    stagnant = found.size === before ? stagnant + 1 : 0;
    if (round % 5 === 0) console.log(`[pull-kanbans] collecting... ${found.size}`);
  }
  return [...found.values()].slice(0, LIMIT);
}

async function readViewPage(page) {
  await page.locator('.view-form .form-group label.form-lable').first().waitFor({ state: 'visible', timeout: 20_000 });
  return page.evaluate(() => {
    const fields = {};
    document.querySelectorAll('.view-form .form-group').forEach((g) => {
      const lab = g.querySelector('label.form-lable');
      if (!lab) return;
      const name = lab.textContent.trim().replace(/\s+/g, ' ');
      const swatch = g.querySelector('div[style*="background-color"]');
      let value;
      if (swatch) value = ((swatch.getAttribute('style') || '').match(/background-color:\s*([^;]+)/) || [])[1]?.trim() ?? null;
      else {
        const clone = (g.querySelector('p') || g).cloneNode(true);
        clone.querySelectorAll('label,img').forEach((e) => e.remove());
        value = clone.textContent.replace(/\s+/g, ' ').trim();
      }
      fields[name] = value;
    });
    const img = document.querySelector('.view-kanban-card img.stdopImage');
    return { fields, pictureUrl: img?.getAttribute('src') || null };
  });
}

async function pullOne(page, card, position) {
  const id = idOf(card.href);
  await page.goto(card.href, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  const { fields, pictureUrl } = await readViewPage(page);
  let picture = null;
  if (pictureUrl) {
    const resp = await page.context().request.get(pictureUrl, { timeout: 20_000 });
    if (resp.ok()) {
      const bytes = await resp.body();
      const file = `${id}${sniffExt(bytes)}`;
      fs.mkdirSync(IMG, { recursive: true });
      fs.writeFileSync(path.join(IMG, file), bytes);
      picture = { url: pictureUrl, file, bytes: bytes.length };
    }
  }
  const record = { sourceUrl: card.href, sourceId: id, position, list: { title: card.title, color: card.color, thumb: card.thumb, ...card.rows }, fields, picture, scrapedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(OUT, `${id}.json`), JSON.stringify(record, null, 1), 'utf8');
  return record;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const existing = new Set();
  for (const f of fs.readdirSync(OUT)) {
    if (!f.endsWith('.json') || f === 'manifest.json' || f === 'errors.json' || f.startsWith('.')) continue;
    try { existing.add(JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')).sourceUrl); } catch {}
  }

  const { browser, page } = await launch();
  const errors = [];
  try {
    console.log('[pull-kanbans] logging in...');
    await login(page);

    let cards;
    if (ONLY_URL) {
      cards = [{ href: ONLY_URL, title: 'retry', rows: {}, color: null, thumb: null }];
    } else {
      await page.goto(new URL('/front-dashboard?tab=kanban', BASE_URL).toString(), { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.locator(CARD_SEL).first().waitFor({ state: 'visible', timeout: 30_000 });
      cards = await collectCards(page);
      const expected = await page.getByText(/KANBANS\s*\((\d+)\)/).first().innerText().then((t) => Number((t.match(/\((\d+)\)/) || [])[1])).catch(() => NaN);
      console.log(`[pull-kanbans] collected ${cards.length} cards (site says ${Number.isNaN(expected) ? '?' : expected})`);
      if (LIMIT === Infinity && Number.isFinite(expected) && cards.length !== expected) console.warn(`[pull-kanbans] WARNING: expected ${expected} but collected ${cards.length}`);
      fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(cards.map((c, i) => ({ position: i + 1, href: c.href, id: idOf(c.href), title: c.title })), null, 1), 'utf8');
    }

    let done = 0;
    for (const [i, card] of cards.entries()) {
      if (existing.has(card.href)) { done++; continue; }
      try {
        const r = await withTimeout(pullOne(page, card, i + 1), 90_000, card.href);
        done++;
        if (done % 10 === 0 || cards.length < 20) console.log(`[pull-kanbans] ${done}/${cards.length}  ${r.list.title.slice(0, 60)}`);
      } catch (e) {
        errors.push({ href: card.href, error: e.message.split('\n')[0] });
        console.error(`[pull-kanbans] FAILED ${card.href}: ${e.message.split('\n')[0]}`);
      }
      await sleep(900 + Math.random() * 900); // pacing: be gentle with their server
    }
    fs.writeFileSync(path.join(OUT, 'errors.json'), JSON.stringify(errors, null, 1), 'utf8');
    console.log(`[pull-kanbans] done. ${done}/${cards.length} on disk, ${errors.length} failed.`);
  } catch (e) {
    console.error('[pull-kanbans] fatal:', e.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
