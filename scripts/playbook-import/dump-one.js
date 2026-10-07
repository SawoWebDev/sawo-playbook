const { launch, login, dump } = require('./lib');

(async () => {
  const { browser, page } = await launch();
  try {
    console.log('[dump-one] logging in...');
    await login(page);
    await dump(page, 'after-login');

    console.log('[dump-one] looking for STD OPS nav...');
    const stdOpsLink = page.getByText(/STD OPS/i).first();
    if (await stdOpsLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await stdOpsLink.click();
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    }
    const cardLinkSel = 'a.stdops_anchur[href^="https"]';
    await page.locator(cardLinkSel).first().waitFor({ state: 'visible', timeout: 20_000 });
    await dump(page, 'list');

    console.log('[dump-one] navigating to first SOP detail page...');
    const href = await page.locator(cardLinkSel).first().getAttribute('href');
    console.log('[dump-one] detail href:', href);
    await page.goto(href, { waitUntil: 'networkidle', timeout: 20_000 });
    await dump(page, 'detail');

    console.log('[dump-one] done. Inspect scripts/gemba-import/debug/*.html and *.png');
  } catch (err) {
    console.error('[dump-one] error:', err.message);
    await dump(page, 'error').catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
