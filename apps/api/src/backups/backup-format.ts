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
 * Ids inside the file are the source system's ids; a restore generates fresh ones and remaps every link.
 * ABANDONED (discarded) draft versions are not part of a backup.
 */
export const BACKUP_FORMAT = 'gembadocs-sop-backup' /* file-format id: kept so older backups still restore */;
export const BACKUP_FORMAT_VERSION = 1;

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
  counts: { folders: number; users: number; sops: number; versions: number; steps: number; media: number; mediaBytes: number; kanbans?: number };
  files: { folders: string; users: string; media: string; sops: string[]; kanbans?: string };
  warnings: string[];
}

export const MAX_JSON_ENTRY_BYTES = 25 * 1024 * 1024;
