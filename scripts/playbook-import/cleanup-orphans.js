require('dotenv').config();
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const loginResp = await fetch(new URL('/api/auth/login', APP_BASE_URL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.APP_EMAIL, password: process.env.APP_PASSWORD }),
  });
  const { accessToken } = await loginResp.json();

  const listResp = await fetch(new URL('/api/sops?limit=200', APP_BASE_URL), { headers: { Authorization: `Bearer ${accessToken}` } });
  const list = await listResp.json();

  const broken = [];
  for (const s of list.items) {
    await sleep(350);
    const vResp = await fetch(new URL(`/api/sops/${s.id}/versions/${s.activeVersion.id}`, APP_BASE_URL), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const v = await vResp.json();
    if (v.steps.length === 0) broken.push(s);
  }

  console.log(`deleting ${broken.length} broken (0-step) SOP(s)...`);
  for (const sop of broken) {
    await sleep(350);
    const resp = await fetch(new URL(`/api/sops/${sop.id}`, APP_BASE_URL), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    console.log(sop.name, '->', resp.status);
  }
})();
