/** Display wording for permission keys (e.g. "kanban.publish"). The set of keys itself comes from the API. */

const AREA_NAME: Record<string, string> = { kanban: 'Kanbans', sop: 'STD OPS', org: 'Organisation', skills: 'Skills', analytics: 'Analytics', audit: 'Audit' };

export const areaName = (area: string) => AREA_NAME[area] ?? area.charAt(0).toUpperCase() + area.slice(1);

/** The action part of a permission key, as words. */
export function actionLabel(key: string): string {
  const action = key.split('.').slice(1).join(' ').replace(/_/g, ' ');
  return action.charAt(0).toUpperCase() + action.slice(1);
}

/** Display text for a permission key, with its area. */
export function permissionLabel(key: string): string {
  return `${areaName(key.split('.')[0])} · ${actionLabel(key)}`;
}
