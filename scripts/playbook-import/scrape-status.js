const fs = require('fs');
const { launch, login, BASE_URL } = require('./lib');

const CARD_LINK_SEL = 'a.stdops_anchur[href^="https"]';

async function collectStatus(page) {
  const found = new Map(); // href -> isDraft
  let stagnantRounds = 0;

  for (let round = 0; round < 80 && stagnantRounds < 5; round++) {
    const cards = await page.$$eval(CARD_LINK_SEL, (as) =>
      as.map((a) => ({
        href: a.getAttribute('href'),
        isDraft: !!a.querySelector('.sop_title_name .text-warning, span.text-warning'),
      })),
    );
    const before = found.size;
    for (const c of cards) found.set(c.href, c.isDraft);

    await page.mouse.wheel(0, 3000);
    await page.waitForTimeout(400);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(400);

    stagnantRounds = found.size === before ? stagnantRounds + 1 : 0;
  }
  return found;
}

(async () => {
  const { browser, page } = await launch();
  try {
    console.log('[scrape-status] logging in...');
    await login(page);
    await page.goto(new URL('/front-dashboard?tab=stdop', BASE_URL).toString(), { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.locator(CARD_LINK_SEL).first().waitFor({ state: 'visible', timeout: 20_000 });

    console.log('[scrape-status] scrolling and collecting status for all SOPs...');
    const statusMap = await collectStatus(page);
    console.log('[scrape-status] collected:', statusMap.size);

    const obj = Object.fromEntries(statusMap);
    fs.writeFileSync('output/.draft-status.json', JSON.stringify(obj, null, 2), 'utf8');
    const draftCount = [...statusMap.values()].filter(Boolean).length;
    console.log(`[scrape-status] drafts: ${draftCount} | published: ${statusMap.size - draftCount}`);
  } finally {
    await browser.close();
  }
})();
