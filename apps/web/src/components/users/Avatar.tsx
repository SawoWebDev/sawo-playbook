/** Initials avatar for people in User Management. The colour is derived from the name, so it stays the same everywhere. */

const AVATAR_COLORS = ['#a67c52', '#8c5e38', '#b98d5e', '#74491f', '#c9a882', '#5a7d6b', '#6b6f9c', '#9c6b6b'];

function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export function Avatar({ name, size = 30 }: { name: string; size?: number }) {
  return (
    <span className="grp-avatar" style={{ width: size, height: size, background: avatarColor(name), fontSize: size * 0.38 }} title={name}>
      {initials(name)}
    </span>
  );
}

/** Font Awesome icon for each role. Display only. */
export const ROLE_ICON: Record<string, string> = {
  ADMIN: 'fa-crown',
  EDITOR: 'fa-pen-to-square',
  OPERATOR: 'fa-eye',
  PRE_APPROVER: 'fa-clipboard-check',
  APPROVER: 'fa-circle-check',
};
