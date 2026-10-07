/**
 * Full-backup file format (a single .zip):
 *
 *   manifest.json        what this file is, when/who made it, counts, and the list of files below
 *   folders.json         the folder tree
 *   users.json           the people referenced by the SOPs (creators, submitters, publishers, approvers)
 *   media.json           index of every image/file: id, original name, mime type, size, sha256, zip path
 *   sops/NNNN-<ref>.json one file per SOP: all its versions, steps, step↔media links, approvals and config
 *   kanbans.json         every kanban with all its fields, picture and extra images (optional: absent in older backups)
 *   media/<id>.<ext>     the binary for each entry in media.json
 *
 * Format 2 adds the optional sections below. Each file is present only when its section was selected:
 *   settings.json        organisation settings: approval rules, role permissions, menu layout
 *   groups.json          groups and their members
 *   invitations.json     pending invitations (the invitation token is never included)
 *   kanban-revisions.json  open and historical kanban change proposals
 *   training.json        trainer assignments, skill assessments and current skill records
 *   checklists.json      checklist submissions and their responses
 *   activity.json        activity events
 * Users in format 2 also carry role, status, extra permissions and sign-in dates. Passwords, two-factor secrets,
 * sessions and reset tokens are never written.
 *
 * Ids inside the file are the source system's ids; a restore generates fresh ones and remaps every link.
 * ABANDONED (discarded) draft versions are not part of a backup.
 */
export const BACKUP_FORMAT = 'sawo-playbook-sop-backup';
/** Format id written before the rename. Still accepted on restore so older backup files keep working. */
export const BACKUP_FORMAT_LEGACY = 'gembadocs-sop-backup';
export const BACKUP_FORMAT_VERSION = 2;

/** What a backup can include. A full backup has them all. */
export const BACKUP_SECTIONS = ['sops', 'kanbans', 'people', 'settings', 'training', 'checklists', 'activity'] as const;
export type BackupSection = (typeof BACKUP_SECTIONS)[number];

export interface BackupFolder {
  id: string;
  parentId: string | null;
  name: string;
  createdAt: string;
}

export interface BackupUser {
  id: string;
  name: string;
  email: string;
  /** Present only in a transfer backup made with passwords included. The argon2 hash exactly as stored. */
  passwordHash?: string | null;
  /** Format 2, people section only. */
  orgRole?: string;
  status?: string;
  extraPermissions?: string[];
  mfaEnabled?: boolean;
  lastLoginAt?: string | null;
  createdAt?: string;
}

export interface BackupMediaEntry {
  id: string;
  file: string;
  type: 'image' | 'video' | 'pdf' | 'document';
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  createdAt: string;
  createdById: string;
  /** Present when the file could not be read from storage at backup time. */
  missing?: boolean;
}

export interface BackupStep {
  id: string;
  order: number;
  title: string | null;
  description: string;
  isTextOnly: boolean;
  isCritical: boolean;
  usesOkNotokMedia: boolean;
  plannedTimeSeconds: number;
  linkedSopId: string | null;
  linkedSopVersionId: string | null;
  media: { assetId: string; displayOrder: number }[];
}

export interface BackupApproval {
  approvalRound: number;
  approverId: string;
  decision: 'approved' | 'rejected';
  comment: string | null;
  createdAt: string;
}

export type BackupLifecycle = 'DRAFT' | 'PENDING_PRE_APPROVAL' | 'PENDING_APPROVAL' | 'APPROVED' | 'PUBLISHED';

export interface BackupVersion {
  id: string;
  versionSequence: number;
  config: Record<string, unknown>;
  lifecycleState: BackupLifecycle;
  currentApprovalRound: number;
  changeSummary: string | null;
  createdAt: string;
  createdById: string;
  submittedAt: string | null;
  submittedById: string | null;
  approvedAt: string | null;
  publishedAt: string | null;
  publishedById: string | null;
  steps: BackupStep[];
  approvals: BackupApproval[];
}

export interface BackupSop {
  id: string;
  /** Position in the source list (newest first) — a restore keeps the same display order. */
  position: number;
  referenceNo: string;
  name: string;
  type: 'standard' | 'advanced' | 'video' | 'document';
  status: string;
  folderId: string | null;
  archivedAt: string | null;
  qrPublicToken: string;
  createdAt: string;
  updatedAt: string;
  createdById: string;
  currentPublishedVersionId: string | null;
  versions: BackupVersion[];
}

export interface BackupKanban {
  id: string;
  /** Position in the source list (newest first). */
  position: number;
  partCode: string;
  partDescription: string | null;
  pictureAssetId: string | null;
  supplier: string | null;
  supplierPartNo: string | null;
  usedFor: string | null;
  orderWhen: string | null;
  orderQty: string | null;
  deliveryTime: string | null;
  location: string | null;
  price: string | null;
  carriage: string | null;
  customField1: string | null;
  customField2: string | null;
  orderingType: 'url' | 'sop' | 'email';
  orderingUrl: string | null;
  orderingSopId: string | null;
  orderingEmail: string | null;
  tag: string | null;
  color: string | null;
  barcode: string | null;
  template: string;
  createdAt: string;
  updatedAt: string;
  createdById: string;
  /** Extra images attached to the kanban (besides the picture). */
  mediaAssetIds: string[];
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  createdAt: string;
  createdBy: { name: string; email: string };
  organization: { name: string };
  source: { app: string };
  /** Sections included in this backup. Absent in format 1 files, which hold SOPs and kanbans. */
  sections?: BackupSection[];
  /** True when users.json carries sign-in password hashes (one-time transfer). */
  passwords?: boolean;
  counts: { folders: number; users: number; sops: number; versions: number; steps: number; media: number; mediaBytes: number; kanbans?: number; [other: string]: number | undefined };
  files: { folders: string; users: string; media: string; sops: string[]; kanbans?: string; [other: string]: string | string[] | undefined };
  warnings: string[];
}

export interface BackupGroup {
  id: string;
  name: string;
  createdAt: string;
  memberIds: string[];
}

export interface BackupSettings {
  approvalRequired: boolean;
  approvalQuorum: number;
  allowSelfApproval: boolean;
  publicSopViewing: boolean;
  rolePermissions: unknown;
  navConfig: unknown;
}

export interface BackupRevision {
  id: string;
  kanbanId: string | null;
  /** Prisma KanbanRevisionState name. */
  state: string;
  payload: Record<string, unknown>;
  routingGroupIds: string[];
  createdById: string;
  updatedById: string;
  submittedById: string | null;
  submittedAt: string | null;
  preApprovedById: string | null;
  preApprovedAt: string | null;
  approvedById: string | null;
  approvedAt: string | null;
  publishedById: string | null;
  publishedAt: string | null;
  lastComment: string | null;
  lastCommentById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BackupTraining {
  trainerAssignments: { trainerId: string; associateId: string; assignedById: string; createdAt: string }[];
  skillAssessments: { id: string; associateId: string; sopId: string; sopVersionId: string; level: number; trainerId: string; assessedAt: string; notes: string | null }[];
  skillRecords: { associateId: string; sopId: string; currentLevel: number; currentSopVersionId: string; lastAssessmentId: string; updatedAt: string }[];
}

export interface BackupChecklistResponse {
  id: string;
  stepId: string;
  value: string | null;
  /** Prisma ChecklistResult name (n_a for "n/a"). */
  result: string | null;
  comment: string | null;
  mediaAssetId: string | null;
  recordedAt: string;
}

export interface BackupChecklist {
  id: string;
  sopVersionId: string;
  operatorId: string;
  startedAt: string;
  completedAt: string | null;
  /** Prisma ChecklistStatus name. */
  status: string;
  responses: BackupChecklistResponse[];
}

export interface BackupActivity {
  id: string;
  actorId: string | null;
  eventType: string;
  entityType: string | null;
  entityId: string | null;
  metadata: unknown;
  occurredAt: string;
}

export const MAX_JSON_ENTRY_BYTES = 25 * 1024 * 1024;
