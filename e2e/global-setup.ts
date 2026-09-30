/** Waits until the web app and the API behind it are serving before any test runs. */
export default async function globalSetup() {
  const base = process.env.BASE_URL ?? 'http://localhost:3000';
  const deadline = Date.now() + 5 * 60_000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const [health, login] = await Promise.all([fetch(`${base}/api/health`), fetch(`${base}/login`)]);
      if (health.ok && login.ok) return;
      last = `health ${health.status}, login ${login.status}`;
    } catch (e) {
      last = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Stack not ready at ${base}: ${last}`);
}
