require('dotenv').config();
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decode = (s) =>
  (s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/g, "'")
    .replace(/\s+/g, ' ').trim();

async function get(url, H) {
  for (let i = 0; i < 6; i++) {
    await sleep(700);
    const r = await fetch(url, { headers: H });
    if (r.status === 429) { await sleep(6000); continue; }
    return r.json();
  }
  throw new Error('still throttled: ' + url);
}

(async () => {
  const lr = await fetch('http://localhost:3000/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: process.env.APP_EMAIL, password: process.env.APP_PASSWORD }) });
  const H = { Authorization: 'Bearer ' + (await lr.json()).accessToken };
  const pushed = JSON.parse(fs.readFileSync('output/.pushed.json', 'utf8'));
  const src = {};
  for (const f of fs.readdirSync('output')) {
    if (!f.endsWith('.json') || f === 'manifest.json' || f.startsWith('.')) continue;
    const d = JSON.parse(fs.readFileSync('output/' + f, 'utf8'));
    src[d.sourceUrl] = d;
  }
  const list = await get('http://localhost:3000/api/sops?limit=200', H);
  const byId = Object.fromEntries(list.items.map((i) => [i.id, i]));

  let ok = 0, bad = 0, steps = 0, images = 0;
  for (const [url, st] of Object.entries(pushed)) {
    const item = byId[st.id];
    const vid = item.currentPublishedVersion?.id || item.activeVersion?.id;
    const v = await get(`http://localhost:3000/api/sops/${st.id}/versions/${vid}`, H);
    const d = src[url];
    const problems = [];
    if (!v.steps) problems.push('no steps field: ' + JSON.stringify(v).slice(0, 100));
    else {
      if (v.steps.length !== d.steps.length) problems.push(`step count ${d.steps.length} vs ${v.steps.length}`);
      d.steps.forEach((x, i) => {
        const a = v.steps[i];
        if (!a) return;
        if (decode(a.description) !== decode(x.description)) problems.push(`step ${i + 1} text differs`);
        const wantImg = !!x.localImagePath;
        const hasImg = !!(a.media && a.media.length);
        if (wantImg !== hasImg) problems.push(`step ${i + 1} image ${wantImg} vs ${hasImg}`);
        if (x.plannedTime && a.plannedTimeSeconds != null) {
          const [h, m, s] = x.plannedTime.split(':').map(Number);
          if (h * 3600 + m * 60 + s !== a.plannedTimeSeconds) problems.push(`step ${i + 1} time differs`);
        }
      });
      steps += v.steps.length;
      images += v.steps.filter((a) => a.media && a.media.length).length;
    }
    const expectStatus = item.status;
    if (problems.length) { bad++; console.log('PROBLEM:', st.name, '->', problems.join('; ')); } else ok++;
  }
  console.log(`\nOK: ${ok} | problems: ${bad} | total SOPs: ${Object.keys(pushed).length} | steps checked: ${steps} | images checked: ${images}`);
})();
