// Pushes kanbans pulled by pull-kanbans.js into the local app (picture upload + POST /api/kanbans).
// Resumable: output/kanbans/.pushed.json maps sourceUrl -> new kanban id. Flags: --limit=N, --dry (print the first mapped bodies only).
// Dates / creator / order are applied afterwards by the fidelity step (they are not settable through the API).
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const APP = process.env.APP_BASE_URL || 'http://localhost:3000';
const OUT = path.join(__dirname, 'output', 'kanbans');
const STATE = path.join(OUT, '.pushed.json');
const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1];
const LIMIT = Number(arg('limit')) || Infinity;
const DRY = process.argv.includes('--dry');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function throttledFetch(url, opts) {
  await sleep(350); // the API allows 120 requests/minute
  for (let attempt = 0; attempt < 6; attempt++) {
    const resp = await fetch(url, opts);
    if (resp.status !== 429) return resp;
    const wait = Number(resp.headers.get('retry-after')) || 6;
    console.log(`  [throttle] 429, waiting ${wait}s`);
    await sleep(wait * 1000);
  }
  throw new Error(`${url} still throttled after retries`);
}

function sniffMime(b) {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return ['image/png', '.png'];
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ['image/jpeg', '.jpg'];
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return ['image/gif', '.gif'];
  if (b.length > 11 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return ['image/webp', '.webp'];
  return [null, null];
}

/** gembadocs prints "N/A" / "NO TAG" for empty values. */
const val = (s, max) => {
  if (s == null) return null;
  const t = String(s).replace(/\s+/g, ' ').trim();
  if (!t || /^(n\/a|no tag|-)$/i.test(t)) return null;
  return max ? t.slice(0, max) : t;
};
const money = (s) => {
  const t = val(s);
  if (!t) return null;
  const n = Number(t.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
};

function toDto(rec) {
  const f = rec.fields;
  const title = rec.list.title || '';
  const description = val(f['Part Description'], 2000);
  const partCode =
    val(f['Sawo Inc Part Number'], 100) ??
    (title.match(/^\[([^\]]{1,100})\]/) || [])[1] ??
    val(f['Barcode Number (Code 128)'], 100) ??
    val(f['Supplier Part Number'], 100) ??
    (description ?? title).slice(0, 100) ??
    'KANBAN';
  return {
    partCode: partCode || 'KANBAN',
    partDescription: description,
    supplier: val(f['Supplier'], 200),
    supplierPartNo: val(f['Supplier Part Number'], 200),
    usedFor: val(f['Used For'], 500),
    orderWhen: val(f['Order When'], 200),
    orderQty: val(f['Order Qty'], 200),
    deliveryTime: val(f['Delivery Time'], 200),
    location: val(f['Location'], 200),
    customField1: val(f['Custom Field 1'], 500),
    customField2: val(f['Custom Field 2'], 500),
    barcode: val(f['Barcode Number (Code 128)'], 200),
    tag: val(f['Tag'], 100) ?? val(rec.list['Tag'], 100),
    color: val(f['PDF Header Color'], 30) ?? rec.list.color,
    template: /02/.test(f['Kanban Type'] || '') ? '02' : '01',
    price: money(f['Price']),
    carriage: money(f['Carriage']),
    orderingType: 'url',
    orderingUrl: validUrl(val(f['Ordering Item URL'], 2000)),
  };
}

/** The app only accepts real http(s) links as an ordering URL; gembadocs lets people paste any text there. */
const WEB_LINK = /^https?:\/\/\S+$/i;
function validUrl(u) {
  return u && WEB_LINK.test(u) ? u : null;
}
const textNotLink = (rec) => {
  const u = val(rec.fields['Ordering Item URL'], 2000);
  return !!u && !WEB_LINK.test(u);
};

(async () => {
  const files = fs.readdirSync(OUT).filter((f) => f.endsWith('.json') && !['manifest.json', 'errors.json'].includes(f) && !f.startsWith('.'));
  const recs = files.map((f) => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'))).sort((a, b) => a.position - b.position);
  console.log(`[push-kanbans] ${recs.length} pulled kanban(s) on disk`);
  if (DRY) {
    for (const r of recs.slice(0, 3)) console.log(JSON.stringify(toDto(r)));
    return;
  }

  const lr = await fetch(new URL('/api/auth/login', APP), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: process.env.APP_EMAIL, password: process.env.APP_PASSWORD }) });
  if (!lr.ok) throw new Error(`login failed (${lr.status})`);
  const auth = { Authorization: `Bearer ${(await lr.json()).accessToken}` };
  const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
  const save = () => fs.writeFileSync(STATE, JSON.stringify(state), 'utf8');

  let created = 0, skipped = 0, failed = 0, linksCleared = 0;
  for (const rec of recs) {
    if (created >= LIMIT) break;
    if (state[rec.sourceUrl]) { skipped++; continue; }
    try {
      const body = toDto(rec);
      if (rec.picture?.file) {
        const bytes = fs.readFileSync(path.join(OUT, 'images', rec.picture.file));
        const [mime, ext] = sniffMime(bytes);
        if (mime) {
          const form = new FormData();
          form.append('file', new Blob([bytes], { type: mime }), `${rec.sourceId}${ext}`);
          const up = await throttledFetch(new URL('/api/media', APP), { method: 'POST', headers: auth, body: form });
          if (!up.ok) throw new Error(`picture upload ${up.status} ${(await up.text()).slice(0, 160)}`);
          body.pictureAssetId = (await up.json()).id;
        }
      }
      const res = await throttledFetch(new URL('/api/kanbans', APP), { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`create ${res.status} ${(await res.text()).slice(0, 200)}`);
      if (textNotLink(rec)) linksCleared++;
      state[rec.sourceUrl] = { id: (await res.json()).id, partCode: body.partCode };
      save();
      created++;
      if (created % 25 === 0 || LIMIT < 25) console.log(`[push-kanbans] created ${created}  (${body.partCode})`);
    } catch (e) {
      failed++;
      console.error(`[push-kanbans] FAILED ${rec.sourceId} (${rec.list.title.slice(0, 40)}): ${e.message}`);
    }
  }
  console.log(`[push-kanbans] done: ${created} created, ${skipped} already pushed, ${failed} failed`);
  if (linksCleared) console.log(`[push-kanbans] note: ${linksCleared} ordering URL(s) were plain text rather than web links, so they were left empty (the original text is kept in the pulled JSON)`);
})().catch((e) => {
  console.error('[push-kanbans] fatal:', e.message);
  process.exit(1);
});
