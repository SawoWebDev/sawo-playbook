/** Reusable SOP fixtures for suites that depend on "the SOP" (Phases 4, 6, 7). */
import { OrgRole } from '@prisma/client';
import { Tenant, TestContext } from './harness';

export const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

export function sopHelpers(ctx: () => TestContext) {
  const as = (t: Tenant, role: OrgRole) => t.users[role].auth;

  async function createSop(t: Tenant, name = 'Test SOP') {
    const res = await ctx().http().post('/api/sops').set(as(t, 'EDITOR')).send({ name }).expect(201);
    return { sopId: res.body.id as string, versionId: res.body.activeVersionId as string };
  }

  async function saveSteps(t: Tenant, sopId: string, versionId: string, steps: object[]) {
    return ctx().http().put(`/api/sops/${sopId}/versions/${versionId}/steps`).set(as(t, 'EDITOR')).send({ steps }).expect(200);
  }

  async function setConfig(t: Tenant, sopId: string, versionId: string, config: object) {
    return ctx().http().patch(`/api/sops/${sopId}/versions/${versionId}`).set(as(t, 'EDITOR')).send({ config }).expect(200);
  }

  async function publishFlow(t: Tenant, sopId: string, versionId: string) {
    const http = ctx().http;
    await http().post(`/api/sops/${sopId}/versions/${versionId}/submit`).set(as(t, 'EDITOR')).send({}).expect(200);
    for (const r of ['APPROVER', 'ADMIN', 'OWNER'] as const) {
      await http().post(`/api/sops/${sopId}/versions/${versionId}/decisions`).set(as(t, r)).send({ decision: 'approved' }).expect(200);
    }
    await http().post(`/api/sops/${sopId}/versions/${versionId}/publish`).set(as(t, 'APPROVER')).expect(200);
  }

  /** Creates and publishes an SOP with `steps` (default two steps). */
  async function publishedSop(t: Tenant, opts: { name?: string; steps?: object[]; config?: object } = {}) {
    const { sopId, versionId } = await createSop(t, opts.name);
    await saveSteps(t, sopId, versionId, opts.steps ?? [{ description: 'Step one', plannedTimeSeconds: 10 }, { description: 'Step two', plannedTimeSeconds: 20 }]);
    if (opts.config) await setConfig(t, sopId, versionId, opts.config);
    await publishFlow(t, sopId, versionId);
    return { sopId, versionId };
  }

  /** New version via copy-on-write, optionally edited, then published. */
  async function republish(t: Tenant, sopId: string, steps?: object[]) {
    const d = await ctx().http().post(`/api/sops/${sopId}/versions`).set(as(t, 'EDITOR')).expect(201);
    if (steps) await saveSteps(t, sopId, d.body.id, steps);
    await publishFlow(t, sopId, d.body.id);
    return d.body.id as string;
  }

  return { as, createSop, saveSteps, setConfig, publishFlow, publishedSop, republish };
}
