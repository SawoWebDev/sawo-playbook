require('dotenv').config();
const fs = require('fs');

const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function throttledFetch(url, opts) {
  await sleep(300);
  for (let attempt = 0; attempt < 6; attempt++) {
    const resp = await fetch(url, opts);
    if (resp.status !== 429) return resp;
    const retryAfter = Number(resp.headers.get('retry-after')) || 5;
    await sleep(retryAfter * 1000);
  }
  throw new Error(`${url} -> still 429 after retries`);
}

(async () => {
  const loginResp = await fetch(new URL('/api/auth/login', APP_BASE_URL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.APP_EMAIL, password: process.env.APP_PASSWORD }),
  });
  const { accessToken } = await loginResp.json();

  const pushed = JSON.parse(fs.readFileSync('output/.pushed.json', 'utf8'));
  const draftStatus = JSON.parse(fs.readFileSync('output/.draft-status.json', 'utf8')); // href -> isDraft on gembadocs.com
  const bySourceUrl = {};
  for (const f of fs.readdirSync('output')) {
    if (!f.endsWith('.json') || f === 'manifest.json' || f.startsWith('.')) continue;
    const d = JSON.parse(fs.readFileSync('output/' + f, 'utf8'));
    bySourceUrl[d.sourceUrl] = d;
  }

  const listResp = await fetch(new URL('/api/sops?limit=200', APP_BASE_URL), { headers: { Authorization: `Bearer ${accessToken}` } });
  const list = await listResp.json();
  const byId = {};
  for (const s of list.items) byId[s.id] = s;

  let published = 0, keptAsDraft = 0, alreadyPublished = 0, failed = 0, forcedDraft = 0;
  for (const [sourceUrl, state] of Object.entries(pushed)) {
    const src = bySourceUrl[sourceUrl];
    const appSop = byId[state.id];
    if (!src || !appSop) continue;

    const isDraftOnSource = draftStatus[sourceUrl];
    if (isDraftOnSource === undefined) {
      console.error('NO STATUS DATA for', src.name, sourceUrl);
      continue;
    }
    if (isDraftOnSource) {
      keptAsDraft++;
      continue;
    }
    if (src.steps.length === 0) {
      // Published on gembadocs.com but genuinely has 0 steps — our schema can't publish an
      // empty version ("Add at least one step before publishing"), so this is a forced,
      // unavoidable deviation from the source.
      forcedDraft++;
      console.log('FORCED DRAFT (published on source but 0 steps, cannot publish here):', src.name);
      continue;
    }
    if (appSop.status === 'published') {
      alreadyPublished++;
      continue;
    }

    const versionId = appSop.activeVersion.id;
    const resp = await throttledFetch(new URL(`/api/sops/${appSop.id}/versions/${versionId}/finish`, APP_BASE_URL), {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (resp.ok) {
      published++;
      console.log('published:', src.name);
    } else {
      failed++;
      console.error('FAILED:', src.name, resp.status, await resp.text());
    }
  }
  console.log(`\npublished: ${published} | already: ${alreadyPublished} | kept as draft (source draft): ${keptAsDraft} | forced draft (0 steps): ${forcedDraft} | failed: ${failed}`);
})();
