const { launch, login, dump, BASE_URL } = require('./lib');

(async () => {
  const { browser, page } = await launch();
  try {
    console.log('[find-api-settings] logging in...');
    await login(page);

    console.log('[find-api-settings] opening PRODUCT menu...');
    const productNav = page.getByText('PRODUCT', { exact: true }).first();
    await productNav.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(800);
    await dump(page, 'product-menu');

    const links = await page.$$eval('a[href]', (as) => as.map((a) => ({ href: a.getAttribute('href'), text: a.innerText.trim() })).filter((l) => l.text && l.href !== 'javascript:;'));
    console.log('[find-api-settings] real links on page:');
    for (const l of links) console.log(` - ${l.text} -> ${l.href}`);
  } catch (err) {
    console.error('[find-api-settings] error:', err.message);
    await dump(page, 'error').catch(() => {});
  } finally {
    await browser.close();
  }
})();
