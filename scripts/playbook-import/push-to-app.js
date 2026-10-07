require('dotenv').config();
const fs = require('fs');
const path = require('path');

const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';
const APP_EMAIL = process.env.APP_EMAIL;
const APP_PASSWORD = process.env.APP_PASSWORD;
const OUT_DIR = path.join(__dirname, 'output');
const PUSHED_STATE_PATH = path.join(OUT_DIR, '.pushed.json');
// `node push-to-app.js --batch=15` pushes at most 15 NEW SOPs this run, then stops (already-pushed ones still skip instantly).
const BATCH = Number((process.argv.find((a) => a.startsWith('--batch=')) || '').split('=')[1]) || Infinity;

// Dedup by sourceUrl (always unique), not by name — several real SOPs on gembadocs.com are
// literally all named "N/A", so name-based dedup would wrongly treat them as duplicates of
// each other and only ever create one.
function loadPushedState() {
  try {
    return JSON.parse(fs.readFileSync(PUSHED_STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}
function savePushedState(state) {
  fs.writeFileSync(PUSHED_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function parsePlannedSeconds(hhmmss) {
  if (!hhmmss) return undefined;
  const [h, m, s] = hhmmss.split(':').map(Number);
  if ([h, m, s].some(Number.isNaN)) return undefined;
  return h * 3600 + m * 60 + s;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Our own API's global throttle is 120 req/min; pace + retry so a 50+ SOP push doesn't trip it.
async function throttledFetch(url, opts) {
  await sleep(350);
  for (let attempt = 0; attempt < 6; attempt++) {
    const resp = await fetch(url, opts);
    if (resp.status !== 429) return resp;
    const retryAfter = Number(resp.headers.get('retry-after')) || 5;
    console.log(`  [throttle] 429, waiting ${retryAfter}s (attempt ${attempt + 1})...`);
    await sleep(retryAfter * 1000);
  }
  throw new Error(`${url} -> still 429 after retries`);
}

async function api(accessToken, method, urlPath, body) {
  const resp = await throttledFetch(new URL(urlPath, APP_BASE_URL), {
    method,
    headers: {
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) throw new Error(`${method} ${urlPath} -> ${resp.status} ${await resp.text()}`);
  return resp.status === 204 ? null : resp.json();
}

// gembadocs.com sometimes serves JPEG bytes at a URL that ends in .png (and vice versa), so the
// locally-saved extension isn't trustworthy — sniff the real file content instead.
function sniffImageMime(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'image/webp';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  return 'application/octet-stream';
}
const EXT_BY_MIME = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };

async function uploadMedia(accessToken, filePath) {
  const bytes = fs.readFileSync(filePath);
  const type = sniffImageMime(bytes);
  const ext = EXT_BY_MIME[type] || path.extname(filePath);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), path.basename(filePath, path.extname(filePath)) + ext);
  const resp = await throttledFetch(new URL('/api/media', APP_BASE_URL), {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });
  if (!resp.ok) throw new Error(`upload ${filePath} -> ${resp.status} ${await resp.text()}`);
  return resp.json();
}

(async () => {
  if (!APP_EMAIL || !APP_PASSWORD) {
    console.error('Set APP_EMAIL and APP_PASSWORD in scripts/playbook-import/.env (the account you created at localhost:3000)');
    process.exit(1);
  }

  console.log('[push] logging in to our app...');
  const session = await api(null, 'POST', '/api/auth/login', { email: APP_EMAIL, password: APP_PASSWORD });
  const accessToken = session.accessToken;
  console.log(`[push] logged in as ${session.user?.email ?? APP_EMAIL}`);

  // Push oldest-on-gembadocs.com first, newest last: our list sorts by updatedAt desc,
  // so the last one pushed ends up on top — matching gembadocs.com's own newest-first order.
  // pull-all.js writes each SOP's file the moment it's scraped, in site order (newest first),
  // so file mtime — not manifest.json, which is only flushed when a pull run finishes —
  // is the reliable signal, including mid-pull when manifest.json is stale.
  const allFiles = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.json') && f !== 'manifest.json' && !f.startsWith('.'));
  const files = allFiles
    .map((f) => ({ f, mtime: fs.statSync(path.join(OUT_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime) // latest-written (= oldest on site) first
    .map((x) => x.f);
  console.log(`[push] found ${files.length} pulled SOP file(s)`);

  const pushedState = loadPushedState();
  const results = [];
  let pushedThisRun = 0;
  for (const file of files) {
    if (pushedThisRun >= BATCH) {
      console.log(`[push] batch limit (${BATCH}) reached, stopping — rerun to continue with the next batch`);
      break;
    }
    const record = JSON.parse(fs.readFileSync(path.join(OUT_DIR, file), 'utf8'));

    if (pushedState[record.sourceUrl]) {
      results.push({ name: record.name, status: 'skipped' });
      continue;
    }

    console.log(`[push] creating SOP: ${record.name}`);
    let sop;
    try {
      const name = record.name || record.list?.title || 'N/A';
      sop = await api(accessToken, 'POST', '/api/sops', { name, type: 'standard' });
      const draftVersion = sop.versions.find((v) => v.versionSequence === 1);

      const steps = [];
      for (const step of record.steps) {
        let media = [];
        if (step.localImagePath && fs.existsSync(step.localImagePath)) {
          const asset = await uploadMedia(accessToken, step.localImagePath);
          media = [{ mediaAssetId: asset.id }];
        }
        steps.push({
          description: step.description,
          plannedTimeSeconds: parsePlannedSeconds(step.plannedTime),
          media,
        });
      }

      await api(accessToken, 'PUT', `/api/sops/${sop.id}/versions/${draftVersion.id}/steps`, { steps });
      console.log(`  -> created ${APP_BASE_URL}/sops/${sop.id} (${steps.length} steps)`);
      results.push({ name: record.name, id: sop.id, url: `${APP_BASE_URL}/sops/${sop.id}`, status: 'ok' });
      pushedState[record.sourceUrl] = { id: sop.id, name: record.name };
      savePushedState(pushedState);
      pushedThisRun++;
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
      if (sop?.id) {
        await api(accessToken, 'DELETE', `/api/sops/${sop.id}`).catch(() => {});
        console.error(`  cleaned up partially-created SOP ${sop.id}`);
      }
      results.push({ name: record.name, status: 'error', error: err.message });
      pushedThisRun++;
    }
  }

  const ok = results.filter((r) => r.status === 'ok');
  const failed = results.filter((r) => r.status === 'error');
  const skipped = results.filter((r) => r.status === 'skipped');
  console.log(`\n[push] summary: ${ok.length} created, ${skipped.length} skipped (already existed), ${failed.length} failed`);
  for (const r of ok) console.log(` - ${r.url} (${r.name})`);
  for (const r of failed) console.log(` - FAILED: ${r.error} (${r.name})`);
})();
