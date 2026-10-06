'use client';

import { useSyncExternalStore } from 'react';
import type { Role } from './api';

/**
 * Preview as role, copied from the REACT_SITE (src/Administrator/previewRole.js). Lets a user who can manage roles see
 * the app the way another role would see it. This only changes what the UI shows: the real session is unchanged, and
 * every request is still checked by the server against the real user. The choice lasts for this browser session.
 */

const KEY = 'sawo_preview_role';

/** The roles that can be previewed. OPERATOR is the Viewer role. */
export const PREVIEWABLE_ROLES: Role[] = ['ADMIN', 'EDITOR', 'OPERATOR', 'PRE_APPROVER', 'APPROVER'];

const listeners = new Set<() => void>();

function readStored(): Role | null {
  try {
    const v = sessionStorage.getItem(KEY) as Role | null;
    return v && PREVIEWABLE_ROLES.includes(v) ? v : null;
  } catch {
    return null;
  }
}

// useSyncExternalStore needs a stable snapshot between notifications, so the value is cached here.
let snapshot: Role | null = typeof window === 'undefined' ? null : readStored();

export function getPreviewRole(): Role | null {
  return snapshot;
}

export function setPreviewRole(role: Role | null): void {
  const next = role && PREVIEWABLE_ROLES.includes(role) ? role : null;
  try {
    if (next) sessionStorage.setItem(KEY, next);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage blocked: the preview lasts for this page only */
  }
  if (snapshot !== next) {
    snapshot = next;
    listeners.forEach((fn) => fn());
  }
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Subscribes a component to the preview role, so every consumer updates the moment it changes. */
export function usePreviewRole(): Role | null {
  return useSyncExternalStore(subscribe, getPreviewRole, () => null);
}
