// Sets Created Date, Last Modified and Created By on the imported kanbans to their gembadocs values.
// The kanban API cannot set these, so a short script is run inside the api container with its Prisma client and removed afterwards.
// Same-day kanbans keep gembadocs' list order: the one higher up on gembadocs gets the later creation time (1 second apart).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.join(__dirname, 'output', 'kanbans');
const WORK = path.join(REPO, 'apps', 'api', 'scripts');

const state = JSON.parse(fs.readFileSync(path.join(OUT, '.pushed.json'), 'utf8'));
const recs = fs
  .readdirSync(OUT)
  .filter((f) => f.endsWith('.json') && !['manifest.json', 'errors.json'].includes(f) && !f.startsWith('.'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')))
  .sort((a, b) => a.position - b.position);

const day = (s) => {
  const t = new Date(String(s).replace(',', '')).getTime();
  if (Number.isNaN(t)) throw new Error(`cannot read date "${s}"`);
  return t;
};

const groups = new Map();
for (const r of recs) {
  const k = day(r.list['Created Date']);
  groups.set(k, [...(groups.get(k) ?? []), r.sourceUrl]);
}
const rows = recs
  .filter((r) => state[r.sourceUrl])
  .map((r) => {
    const base = day(r.list['Created Date']);
    const same = groups.get(base);
    return {
      kanbanId: state[r.sourceUrl].id,
      createdByName: r.list['Created By'] || 'Unknown',
      createdAt: new Date(base + (same.length - 1 - same.indexOf(r.sourceUrl)) * 1000).toISOString(),
      updatedAt: new Date(day(r.list['Last Modified'])).toISOString(),
    };
  });
console.log(`[kanban-fidelity] ${rows.length} imported kanbans to update (of ${recs.length} pulled)`);
if (!rows.length) process.exit(0);

const script = `
const { PrismaClient } = require('@prisma/client');
const rows = require('./kanban-fidelity-data.json');
const prisma = new PrismaClient();
(async () => {
  const orgId = (await prisma.kanban.findUniqueOrThrow({ where: { id: rows[0].kanbanId } })).organizationId;
  const creator = new Map();
  for (const name of new Set(rows.map((r) => r.createdByName))) {
    const email = 'imported.' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '@gembadocs-import.local';
    const u = await prisma.user.upsert({ where: { email }, update: {}, create: { organizationId: orgId, email, name, status: 'invited', orgRole: 'OPERATOR' } });
    creator.set(name, u.id);
  }
  let ok = 0, bad = 0;
  for (const r of rows) {
    try {
      await prisma.kanban.update({ where: { id: r.kanbanId }, data: { createdById: creator.get(r.createdByName), createdAt: new Date(r.createdAt), updatedAt: new Date(r.updatedAt) } });
      ok++;
    } catch (e) { bad++; console.error('FAILED', r.kanbanId, e.message.split('\\n').pop()); }
  }
  console.log('creators:', [...creator.keys()].join(', '));
  console.log('updated', ok, '/', rows.length, '| failed', bad);
})().finally(() => prisma.$disconnect());
`;

const existed = fs.existsSync(WORK);
fs.mkdirSync(WORK, { recursive: true });
const dataFile = path.join(WORK, 'kanban-fidelity-data.json');
const scriptFile = path.join(WORK, 'one-off-kanban-fidelity.js');
try {
  fs.writeFileSync(dataFile, JSON.stringify(rows));
  fs.writeFileSync(scriptFile, script);
  execFileSync('docker', ['compose', 'exec', '-T', 'api', 'node', 'scripts/one-off-kanban-fidelity.js'], { cwd: REPO, stdio: 'inherit' });
} finally {
  fs.rmSync(dataFile, { force: true });
  fs.rmSync(scriptFile, { force: true });
  if (!existed) fs.rmSync(WORK, { recursive: true, force: true });
}
