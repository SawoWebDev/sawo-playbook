// Checks every imported kanban in the app against what was pulled from gembadocs.com:
// count, list order, every text field, price, creator, created/modified dates and the picture (by checksum).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

const APP = process.env.APP_BASE_URL || 'http://localhost:3000';
const OUT = path.join(__dirname, 'output', 'kanbans');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const na = (s) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return !t || /^(n\/a|no tag|-)$/i.test(t) ? null : t;
};
const day = (s) => new Date(String(s).replace(',', '')).getTime();

async function get(url, auth, raw = false) {
  for (let i = 0; i < 8; i++) {
    await sleep(raw ? 520 : 150);
    const r = await fetch(new URL(url, APP), { headers: auth });
    if (r.status === 429) { await sleep(7000); continue; }
    if (!r.ok) throw new Error(`${url} -> ${r.status}`);
    return raw ? Buffer.from(await r.arrayBuffer()) : r.json();
  }
  throw new Error(`${url} still throttled`);
}

(async () => {
  const lr = await fetch(new URL('/api/auth/login', APP), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: process.env.APP_EMAIL, password: process.env.APP_PASSWORD }) });
  const auth = { Authorization: `Bearer ${(await lr.json()).accessToken}` };
  const state = JSON.parse(fs.readFileSync(path.join(OUT, '.pushed.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));
  const recs = new Map();
  for (const f of fs.readdirSync(OUT)) {
    if (!f.endsWith('.json') || ['manifest.json', 'errors.json'].includes(f) || f.startsWith('.')) continue;
    const d = JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
    recs.set(d.sourceUrl, d);
  }

  const items = [];
  for (let offset = 0; ; offset += 500) {
    const page = await get(`/api/kanbans?limit=500&offset=${offset}&sort=createdAt&dir=desc`, auth);
    items.push(...page.items);
    if (items.length >= page.total || !page.items.length) break;
  }
  const byId = new Map(items.map((k) => [k.id, k]));
  console.log(`app has ${items.length} kanbans; ${recs.size} pulled; ${Object.keys(state).length} pushed`);

  // order: gembadocs list order == app order sorted by creation, newest first
  const wantOrder = manifest.map((m) => state[m.href]?.id).filter(Boolean);
  const gotOrder = items.map((k) => k.id).filter((id) => wantOrder.includes(id));
  const orderDiff = wantOrder.filter((id, i) => gotOrder[i] !== id).length;

  const bad = { text: 0, price: 0, creator: 0, created: 0, modified: 0, picture: 0, missing: 0 };
  const sample = [];
  const note = (kind, msg) => { bad[kind]++; if (sample.length < 12) sample.push(`${kind}: ${msg}`); };
  let n = 0;
  for (const [url, rec] of recs) {
    const id = state[url]?.id;
    const k = id && byId.get(id);
    if (!k) { note('missing', rec.sourceId); continue; }
    const f = rec.fields;
    const want = {
      partDescription: na(f['Part Description']), supplier: na(f['Supplier']), supplierPartNo: na(f['Supplier Part Number']), usedFor: na(f['Used For']),
      orderWhen: na(f['Order When']), orderQty: na(f['Order Qty']), deliveryTime: na(f['Delivery Time']), location: na(f['Location']),
      customField1: na(f['Custom Field 1']), customField2: na(f['Custom Field 2']), barcode: na(f['Barcode Number (Code 128)']),
      template: /02/.test(f['Kanban Type'] || '') ? '02' : '01',
    };
    for (const [key, v] of Object.entries(want)) if ((k[key] ?? null) !== v) note('text', `${rec.sourceId} ${key}: "${k[key]}" vs "${v}"`);
    if (k.createdBy?.name !== rec.list['Created By']) note('creator', `${rec.sourceId} ${k.createdBy?.name} vs ${rec.list['Created By']}`);
    const c = new Date(k.createdAt).getTime() - day(rec.list['Created Date']);
    if (c < 0 || c > 600_000) note('created', `${rec.sourceId} ${k.createdAt} vs ${rec.list['Created Date']}`);
    if (new Date(k.updatedAt).getTime() !== day(rec.list['Last Modified'])) note('modified', `${rec.sourceId} ${k.updatedAt} vs ${rec.list['Last Modified']}`);
    if (rec.picture) {
      if (!k.picture?.url) note('picture', `${rec.sourceId} has no picture`);
      else if (sha(await get(k.picture.url, {}, true)) !== sha(fs.readFileSync(path.join(OUT, 'images', rec.picture.file)))) note('picture', `${rec.sourceId} picture differs`);
    }
    if (++n % 100 === 0) console.log(`  checked ${n}/${recs.size}`);
  }
  console.log(`order differs from gembadocs at ${orderDiff} of ${wantOrder.length} positions`);
  console.log('mismatches:', JSON.stringify(bad));
  sample.forEach((s) => console.log('  ' + s));
  process.exitCode = orderDiff || Object.values(bad).some(Boolean) ? 1 : 0;
})().catch((e) => {
  console.error('verify failed:', e.message);
  process.exit(1);
});
