import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BackupActivity,
  BackupChecklist,
  BackupChecklistResponse,
  BackupFolder,
  BackupGroup,
  BackupKanban,
  BackupLifecycle,
  BackupRevision,
  BackupSettings,
  BackupTraining,
  BackupManifest,
  BackupMediaEntry,
  BackupSop,
  BackupStep,
  BackupUser,
  BackupVersion,
} from './backup-format';

/** A backup file is untrusted input: everything is type- and range-checked before it can reach the database. */
export class BackupFormatError extends Error {}

type Obj = Record<string, unknown>;

function obj(v: unknown, what: string): Obj {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new BackupFormatError(`${what} must be an object`);
  return v as Obj;
}
function arr(v: unknown, what: string, max: number): unknown[] {
  if (!Array.isArray(v)) throw new BackupFormatError(`${what} must be a list`);
  if (v.length > max) throw new BackupFormatError(`${what} has too many items (max ${max})`);
  return v;
}
function str(v: unknown, what: string, max: number, opts: { min?: number; nullable?: false } = {}): string {
  if (typeof v !== 'string') throw new BackupFormatError(`${what} must be text`);
  if (v.length < (opts.min ?? 0)) throw new BackupFormatError(`${what} must not be empty`);
  if (v.length > max) throw new BackupFormatError(`${what} is too long (max ${max})`);
  return v;
}
function strOrNull(v: unknown, what: string, max: number): string | null {
  return v === null || v === undefined ? null : str(v, what, max);
}
function int(v: unknown, what: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new BackupFormatError(`${what} must be a whole number between ${min} and ${max}`);
  return v;
}
function bool(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') throw new BackupFormatError(`${what} must be true or false`);
  return v;
}
function date(v: unknown, what: string): string {
  const s = str(v, what, 40, { min: 1 });
  if (Number.isNaN(new Date(s).getTime())) throw new BackupFormatError(`${what} is not a valid date`);
  return s;
}
function dateOrNull(v: unknown, what: string): string | null {
  return v === null || v === undefined ? null : date(v, what);
}
function oneOf<T extends string>(v: unknown, what: string, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !allowed.includes(v as T)) throw new BackupFormatError(`${what} must be one of ${allowed.join(', ')}`);
  return v as T;
}
function id(v: unknown, what: string): string {
  return str(v, what, 100, { min: 1 });
}
function idOrNull(v: unknown, what: string): string | null {
  return v === null || v === undefined ? null : id(v, what);
}

export function parseManifest(raw: unknown): BackupManifest {
  const o = obj(raw, 'manifest.json');
  if (o.format !== BACKUP_FORMAT) throw new BackupFormatError('This is not a SOP backup file (unknown format)');
  const version = int(o.formatVersion, 'formatVersion', 1, 1000);
  if (version > BACKUP_FORMAT_VERSION) throw new BackupFormatError(`This backup was made by a newer version (format ${version}); this app understands format ${BACKUP_FORMAT_VERSION}`);
  const files = obj(o.files, 'files');
  const counts = obj(o.counts, 'counts');
  const sopFiles = arr(files.sops, 'files.sops', 100_000).map((f, i) => {
    const name = str(f, `files.sops[${i}]`, 200, { min: 1 });
    if (!/^sops\/[A-Za-z0-9._-]+\.json$/.test(name)) throw new BackupFormatError(`files.sops[${i}] has an unexpected name`);
    return name;
  });
  if (files.kanbans !== undefined && files.kanbans !== 'kanbans.json') throw new BackupFormatError('files.kanbans has an unexpected name');
  return {
    format: BACKUP_FORMAT,
    formatVersion: version,
    createdAt: date(o.createdAt, 'createdAt'),
    createdBy: { name: str(obj(o.createdBy, 'createdBy').name, 'createdBy.name', 200), email: str(obj(o.createdBy, 'createdBy').email, 'createdBy.email', 320) },
    organization: { name: str(obj(o.organization, 'organization').name, 'organization.name', 300) },
    source: { app: str(obj(o.source, 'source').app, 'source.app', 100) },
    counts: {
      folders: int(counts.folders, 'counts.folders', 0, 1e9),
      users: int(counts.users, 'counts.users', 0, 1e9),
      sops: int(counts.sops, 'counts.sops', 0, 1e9),
      versions: int(counts.versions, 'counts.versions', 0, 1e9),
      steps: int(counts.steps, 'counts.steps', 0, 1e9),
      media: int(counts.media, 'counts.media', 0, 1e9),
      mediaBytes: int(counts.mediaBytes, 'counts.mediaBytes', 0, Number.MAX_SAFE_INTEGER),
      ...(counts.kanbans === undefined ? {} : { kanbans: int(counts.kanbans, 'counts.kanbans', 0, 1e9) }),
    },
    files: {
      folders: 'folders.json',
      users: 'users.json',
      media: 'media.json',
      sops: sopFiles,
      ...(files.kanbans === undefined ? {} : { kanbans: 'kanbans.json' }),
      ...optionalFiles(files, {
        kanbanRevisions: 'kanban-revisions.json',
        groups: 'groups.json',
        invitations: 'invitations.json',
        settings: 'settings.json',
        training: 'training.json',
        checklists: 'checklists.json',
        activity: 'activity.json',
      }),
    },
    warnings: Array.isArray(o.warnings) ? o.warnings.filter((w): w is string => typeof w === 'string').slice(0, 200) : [],
  };
}

export function parseFolders(raw: unknown): BackupFolder[] {
  return arr(raw, 'folders.json', 100_000).map((f, i) => {
    const o = obj(f, `folders[${i}]`);
    return { id: id(o.id, 'folder id'), parentId: idOrNull(o.parentId, 'folder parentId'), name: str(o.name, 'folder name', 300, { min: 1 }), createdAt: date(o.createdAt, 'folder createdAt') };
  });
}

export function parseUsers(raw: unknown): BackupUser[] {
  return arr(raw, 'users.json', 100_000).map((u, i) => {
    const o = obj(u, `users[${i}]`);
    const w = `users[${i}]`;
    return {
      id: id(o.id, 'user id'),
      name: str(o.name, 'user name', 200, { min: 1 }),
      email: str(o.email, 'user email', 320, { min: 3 }),
      orgRole: optional(o, 'orgRole', (v) => oneOf(v, `${w}.orgRole`, ROLE_NAMES)),
      status: optional(o, 'status', (v) => oneOf(v, `${w}.status`, USER_STATUSES)),
      extraPermissions: optional(o, 'extraPermissions', (v) => arr(v, `${w}.extraPermissions`, 200).map((p, j) => str(p, `${w}.extraPermissions[${j}]`, 100, { min: 1 }))),
      passwordHash: optional(o, 'passwordHash', (v) => strOrNull(v, `${w}.passwordHash`, 500)),
      mfaEnabled: optional(o, 'mfaEnabled', (v) => bool(v, `${w}.mfaEnabled`)),
      lastLoginAt: optional(o, 'lastLoginAt', (v) => dateOrNull(v, `${w}.lastLoginAt`)),
      createdAt: optional(o, 'createdAt', (v) => date(v, `${w}.createdAt`)),
    };
  });
}

/** Every role the database holds. OWNER is the legacy form of Admin and TRAINER has no permissions. */
const ROLE_NAMES = ['OWNER', 'ADMIN', 'EDITOR', 'APPROVER', 'TRAINER', 'OPERATOR', 'PRE_APPROVER'] as const;
const USER_STATUSES = ['invited', 'active', 'suspended', 'removed'] as const;
const REVISION_STATES = ['DRAFT', 'PENDING_PRE_APPROVAL', 'PRE_APPROVED', 'APPROVED', 'PUBLISHED', 'DISCARDED'] as const;
const CHECKLIST_STATUSES = ['in_progress', 'completed', 'abandoned'] as const;
const CHECKLIST_RESULTS = ['ok', 'not_ok', 'n_a'] as const;

/** A value that may be missing from an older file. */
function optional<T>(o: Obj, key: string, parse: (v: unknown) => T): T | undefined {
  return o[key] === undefined ? undefined : parse(o[key]);
}

/** Optional files a format 2 backup may list. Each must have its exact expected name, so nothing unexpected is read. */
function optionalFiles(files: Obj, expected: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, name] of Object.entries(expected)) {
    if (files[key] === undefined) continue;
    if (files[key] !== name) throw new BackupFormatError(`files.${key} has an unexpected name`);
    out[key] = name;
  }
  return out;
}

export function parseGroups(raw: unknown): BackupGroup[] {
  return arr(raw, 'groups.json', 10_000).map((g, i) => {
    const o = obj(g, `groups[${i}]`);
    return {
      id: id(o.id, `groups[${i}].id`),
      name: str(o.name, `groups[${i}].name`, 200, { min: 1 }),
      createdAt: date(o.createdAt, `groups[${i}].createdAt`),
      memberIds: arr(o.memberIds ?? [], `groups[${i}].memberIds`, 100_000).map((m, j) => id(m, `groups[${i}].memberIds[${j}]`)),
    };
  });
}

export function parseSettings(raw: unknown): BackupSettings | null {
  if (raw === null || raw === undefined) return null;
  const o = obj(raw, 'settings.json');
  const jsonObjOrNull = (v: unknown, what: string) => (v === null || v === undefined ? null : obj(v, what));
  return {
    approvalRequired: bool(o.approvalRequired, 'settings.approvalRequired'),
    approvalQuorum: int(o.approvalQuorum, 'settings.approvalQuorum', 1, 100),
    allowSelfApproval: bool(o.allowSelfApproval, 'settings.allowSelfApproval'),
    publicSopViewing: bool(o.publicSopViewing, 'settings.publicSopViewing'),
    rolePermissions: jsonObjOrNull(o.rolePermissions, 'settings.rolePermissions'),
    navConfig: jsonObjOrNull(o.navConfig, 'settings.navConfig'),
  };
}

export function parseRevisions(raw: unknown): BackupRevision[] {
  return arr(raw, 'kanban-revisions.json', 1_000_000).map((r, i) => {
    const w = `revision ${i + 1}`;
    const o = obj(r, w);
    return {
      id: id(o.id, `${w} id`),
      kanbanId: idOrNull(o.kanbanId, `${w} kanbanId`),
      state: oneOf(o.state, `${w} state`, REVISION_STATES),
      payload: obj(o.payload, `${w} payload`),
      routingGroupIds: ids(o.routingGroupIds, `${w} routingGroupIds`, 1000),
      createdById: id(o.createdById, `${w} createdById`),
      updatedById: id(o.updatedById, `${w} updatedById`),
      submittedById: idOrNull(o.submittedById, `${w} submittedById`),
      submittedAt: dateOrNull(o.submittedAt, `${w} submittedAt`),
      preApprovedById: idOrNull(o.preApprovedById, `${w} preApprovedById`),
      preApprovedAt: dateOrNull(o.preApprovedAt, `${w} preApprovedAt`),
      approvedById: idOrNull(o.approvedById, `${w} approvedById`),
      approvedAt: dateOrNull(o.approvedAt, `${w} approvedAt`),
      publishedById: idOrNull(o.publishedById, `${w} publishedById`),
      publishedAt: dateOrNull(o.publishedAt, `${w} publishedAt`),
      lastComment: strOrNull(o.lastComment, `${w} lastComment`, 5000),
      lastCommentById: idOrNull(o.lastCommentById, `${w} lastCommentById`),
      createdAt: date(o.createdAt, `${w} createdAt`),
      updatedAt: date(o.updatedAt, `${w} updatedAt`),
    };
  });
}

export function parseTraining(raw: unknown): BackupTraining {
  const o = obj(raw, 'training.json');
  const list = (v: unknown, what: string) => arr(v ?? [], what, 1_000_000);
  return {
    trainerAssignments: list(o.trainerAssignments, 'trainerAssignments').map((t, i) => {
      const x = obj(t, `trainerAssignments[${i}]`);
      return { trainerId: id(x.trainerId, 'trainerId'), associateId: id(x.associateId, 'associateId'), assignedById: id(x.assignedById, 'assignedById'), createdAt: date(x.createdAt, 'trainer createdAt') };
    }),
    skillAssessments: list(o.skillAssessments, 'skillAssessments').map((a, i) => {
      const x = obj(a, `skillAssessments[${i}]`);
      return {
        id: id(x.id, 'assessment id'),
        associateId: id(x.associateId, 'assessment associateId'),
        sopId: id(x.sopId, 'assessment sopId'),
        sopVersionId: id(x.sopVersionId, 'assessment sopVersionId'),
        level: int(x.level, 'assessment level', 0, 4),
        trainerId: id(x.trainerId, 'assessment trainerId'),
        assessedAt: date(x.assessedAt, 'assessment assessedAt'),
        notes: strOrNull(x.notes, 'assessment notes', 2000),
      };
    }),
    skillRecords: list(o.skillRecords, 'skillRecords').map((r, i) => {
      const x = obj(r, `skillRecords[${i}]`);
      return {
        associateId: id(x.associateId, 'record associateId'),
        sopId: id(x.sopId, 'record sopId'),
        currentLevel: int(x.currentLevel, 'record currentLevel', 0, 4),
        currentSopVersionId: id(x.currentSopVersionId, 'record currentSopVersionId'),
        lastAssessmentId: id(x.lastAssessmentId, 'record lastAssessmentId'),
        updatedAt: date(x.updatedAt, 'record updatedAt'),
      };
    }),
  };
}

export function parseChecklists(raw: unknown): BackupChecklist[] {
  return arr(raw, 'checklists.json', 1_000_000).map((s, i) => {
    const w = `checklist ${i + 1}`;
    const o = obj(s, w);
    return {
      id: id(o.id, `${w} id`),
      sopVersionId: id(o.sopVersionId, `${w} sopVersionId`),
      operatorId: id(o.operatorId, `${w} operatorId`),
      startedAt: date(o.startedAt, `${w} startedAt`),
      completedAt: dateOrNull(o.completedAt, `${w} completedAt`),
      status: oneOf(o.status, `${w} status`, CHECKLIST_STATUSES),
      responses: arr(o.responses ?? [], `${w} responses`, 100_000).map((r, j): BackupChecklistResponse => {
        const x = obj(r, `${w} response ${j + 1}`);
        return {
          id: id(x.id, 'response id'),
          stepId: id(x.stepId, 'response stepId'),
          value: strOrNull(x.value, 'response value', 5000),
          result: x.result === null || x.result === undefined ? null : oneOf(x.result, 'response result', CHECKLIST_RESULTS),
          comment: strOrNull(x.comment, 'response comment', 5000),
          mediaAssetId: idOrNull(x.mediaAssetId, 'response mediaAssetId'),
          recordedAt: date(x.recordedAt, 'response recordedAt'),
        };
      }),
    };
  });
}

export function parseActivity(raw: unknown): BackupActivity[] {
  return arr(raw, 'activity.json', 5_000_000).map((e, i) => {
    const o = obj(e, `activity ${i + 1}`);
    return {
      id: id(o.id, 'activity id'),
      actorId: idOrNull(o.actorId, 'activity actorId'),
      eventType: str(o.eventType, 'activity eventType', 200, { min: 1 }),
      entityType: strOrNull(o.entityType, 'activity entityType', 100),
      entityId: strOrNull(o.entityId, 'activity entityId', 100),
      metadata: o.metadata ?? {},
      occurredAt: date(o.occurredAt, 'activity occurredAt'),
    };
  });
}

/** Ids as a list, for optional lists that may be missing. */
function ids(v: unknown, what: string, max: number): string[] {
  return arr(v ?? [], what, max).map((x, i) => id(x, `${what}[${i}]`));
}

export function parseMedia(raw: unknown): BackupMediaEntry[] {
  return arr(raw, 'media.json', 1_000_000).map((m, i) => {
    const o = obj(m, `media[${i}]`);
    const file = str(o.file, 'media file', 200, { min: 1 });
    if (!/^media\/[A-Za-z0-9._-]+$/.test(file)) throw new BackupFormatError(`media[${i}] has an unexpected file name`);
    const dim = (v: unknown, what: string) => (v === null || v === undefined ? null : int(v, what, 0, 1_000_000));
    return {
      id: id(o.id, 'media id'),
      file,
      type: oneOf(o.type, 'media type', ['image', 'video', 'pdf', 'document'] as const),
      originalFilename: str(o.originalFilename, 'media originalFilename', 300),
      mimeType: str(o.mimeType, 'media mimeType', 100),
      sizeBytes: int(o.sizeBytes, 'media sizeBytes', 0, Number.MAX_SAFE_INTEGER),
      sha256: str(o.sha256, 'media sha256', 64),
      width: dim(o.width, 'media width'),
      height: dim(o.height, 'media height'),
      durationSeconds: typeof o.durationSeconds === 'number' ? o.durationSeconds : null,
      createdAt: date(o.createdAt, 'media createdAt'),
      createdById: id(o.createdById, 'media createdById'),
      ...(o.missing === true ? { missing: true } : {}),
    };
  });
}

const LIFECYCLES = ['DRAFT', 'PENDING_PRE_APPROVAL', 'PENDING_APPROVAL', 'APPROVED', 'PUBLISHED'] as const;
const ACTIVE: readonly BackupLifecycle[] = ['DRAFT', 'PENDING_PRE_APPROVAL', 'PENDING_APPROVAL', 'APPROVED'];

function parseStep(raw: unknown, where: string): BackupStep {
  const o = obj(raw, where);
  return {
    id: id(o.id, `${where}.id`),
    order: int(o.order, `${where}.order`, 1, 100_000),
    title: strOrNull(o.title, `${where}.title`, 300),
    description: str(o.description ?? '', `${where}.description`, 50_000),
    isTextOnly: bool(o.isTextOnly, `${where}.isTextOnly`),
    isCritical: bool(o.isCritical, `${where}.isCritical`),
    usesOkNotokMedia: bool(o.usesOkNotokMedia, `${where}.usesOkNotokMedia`),
    plannedTimeSeconds: int(o.plannedTimeSeconds, `${where}.plannedTimeSeconds`, 0, 86_400),
    linkedSopId: idOrNull(o.linkedSopId, `${where}.linkedSopId`),
    linkedSopVersionId: idOrNull(o.linkedSopVersionId, `${where}.linkedSopVersionId`),
    media: arr(o.media, `${where}.media`, 20).map((m, i) => {
      const mo = obj(m, `${where}.media[${i}]`);
      return { assetId: id(mo.assetId, `${where}.media[${i}].assetId`), displayOrder: int(mo.displayOrder, `${where}.media[${i}].displayOrder`, 0, 100_000) };
    }),
  };
}

function parseVersion(raw: unknown, where: string): BackupVersion {
  const o = obj(raw, where);
  const steps = arr(o.steps, `${where}.steps`, 500).map((s, i) => parseStep(s, `${where}.steps[${i}]`));
  const orders = new Set(steps.map((s) => s.order));
  if (orders.size !== steps.length) throw new BackupFormatError(`${where} has two steps with the same order`);
  const config = obj(o.config ?? {}, `${where}.config`);
  if (JSON.stringify(config).length > 200_000) throw new BackupFormatError(`${where}.config is too large`);
  return {
    id: id(o.id, `${where}.id`),
    versionSequence: int(o.versionSequence, `${where}.versionSequence`, 1, 100_000),
    config,
    lifecycleState: oneOf(o.lifecycleState, `${where}.lifecycleState`, LIFECYCLES),
    currentApprovalRound: int(o.currentApprovalRound, `${where}.currentApprovalRound`, 1, 100_000),
    changeSummary: strOrNull(o.changeSummary, `${where}.changeSummary`, 10_000),
    createdAt: date(o.createdAt, `${where}.createdAt`),
    createdById: id(o.createdById, `${where}.createdById`),
    submittedAt: dateOrNull(o.submittedAt, `${where}.submittedAt`),
    submittedById: idOrNull(o.submittedById, `${where}.submittedById`),
    approvedAt: dateOrNull(o.approvedAt, `${where}.approvedAt`),
    publishedAt: dateOrNull(o.publishedAt, `${where}.publishedAt`),
    publishedById: idOrNull(o.publishedById, `${where}.publishedById`),
    steps,
    approvals: arr(o.approvals ?? [], `${where}.approvals`, 10_000).map((a, i) => {
      const ao = obj(a, `${where}.approvals[${i}]`);
      return {
        approvalRound: int(ao.approvalRound, 'approvalRound', 1, 100_000),
        approverId: id(ao.approverId, 'approverId'),
        decision: oneOf(ao.decision, 'decision', ['approved', 'rejected'] as const),
        comment: strOrNull(ao.comment, 'comment', 10_000),
        createdAt: date(ao.createdAt, 'approval createdAt'),
      };
    }),
  };
}

export function parseSop(raw: unknown, file: string): BackupSop {
  const o = obj(raw, file);
  const versions = arr(o.versions, `${file} versions`, 1000).map((v, i) => parseVersion(v, `version ${i + 1}`));
  const seqs = new Set(versions.map((v) => v.versionSequence));
  if (seqs.size !== versions.length) throw new BackupFormatError('two versions share the same version number');
  if (versions.filter((v) => ACTIVE.includes(v.lifecycleState)).length > 1) throw new BackupFormatError('more than one unpublished version');
  const currentPublishedVersionId = idOrNull(o.currentPublishedVersionId, 'currentPublishedVersionId');
  if (currentPublishedVersionId && !versions.some((v) => v.id === currentPublishedVersionId && v.lifecycleState === 'PUBLISHED')) {
    throw new BackupFormatError('currentPublishedVersionId does not point at a published version');
  }
  return {
    id: id(o.id, 'id'),
    position: int(o.position, 'position', 1, 1e9),
    referenceNo: str(o.referenceNo, 'referenceNo', 60, { min: 1 }),
    name: str(o.name, 'name', 300, { min: 1 }),
    type: oneOf(o.type, 'type', ['standard', 'advanced', 'video', 'document'] as const),
    status: str(o.status, 'status', 40),
    folderId: idOrNull(o.folderId, 'folderId'),
    archivedAt: dateOrNull(o.archivedAt, 'archivedAt'),
    qrPublicToken: str(o.qrPublicToken ?? '', 'qrPublicToken', 200),
    createdAt: date(o.createdAt, 'createdAt'),
    updatedAt: date(o.updatedAt, 'updatedAt'),
    createdById: id(o.createdById, 'createdById'),
    currentPublishedVersionId,
    versions: versions.sort((a, b) => a.versionSequence - b.versionSequence),
  };
}

function decimalOrNull(v: unknown, what: string): string | null {
  if (v === null || v === undefined) return null;
  const t = str(v, what, 20);
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(t)) throw new BackupFormatError(`${what} must be a positive amount with at most 2 decimals`);
  return t;
}

function parseKanban(raw: unknown, where: string): BackupKanban {
  const o = obj(raw, where);
  return {
    id: id(o.id, `${where}.id`),
    position: int(o.position, `${where}.position`, 1, 1e9),
    partCode: str(o.partCode, `${where}.partCode`, 100, { min: 1 }),
    partDescription: strOrNull(o.partDescription, `${where}.partDescription`, 2000),
    pictureAssetId: idOrNull(o.pictureAssetId, `${where}.pictureAssetId`),
    supplier: strOrNull(o.supplier, `${where}.supplier`, 200),
    supplierPartNo: strOrNull(o.supplierPartNo, `${where}.supplierPartNo`, 200),
    usedFor: strOrNull(o.usedFor, `${where}.usedFor`, 500),
    orderWhen: strOrNull(o.orderWhen, `${where}.orderWhen`, 200),
    orderQty: strOrNull(o.orderQty, `${where}.orderQty`, 200),
    deliveryTime: strOrNull(o.deliveryTime, `${where}.deliveryTime`, 200),
    location: strOrNull(o.location, `${where}.location`, 200),
    price: decimalOrNull(o.price, `${where}.price`),
    carriage: decimalOrNull(o.carriage, `${where}.carriage`),
    customField1: strOrNull(o.customField1, `${where}.customField1`, 500),
    customField2: strOrNull(o.customField2, `${where}.customField2`, 500),
    orderingType: oneOf(o.orderingType, `${where}.orderingType`, ['url', 'sop', 'email'] as const),
    orderingUrl: strOrNull(o.orderingUrl, `${where}.orderingUrl`, 2000),
    orderingSopId: idOrNull(o.orderingSopId, `${where}.orderingSopId`),
    orderingEmail: strOrNull(o.orderingEmail, `${where}.orderingEmail`, 320),
    tag: strOrNull(o.tag, `${where}.tag`, 100),
    color: strOrNull(o.color, `${where}.color`, 30),
    barcode: strOrNull(o.barcode, `${where}.barcode`, 200),
    template: oneOf(o.template, `${where}.template`, ['01', '02'] as const),
    createdAt: date(o.createdAt, `${where}.createdAt`),
    updatedAt: date(o.updatedAt, `${where}.updatedAt`),
    createdById: id(o.createdById, `${where}.createdById`),
    mediaAssetIds: arr(o.mediaAssetIds ?? [], `${where}.mediaAssetIds`, 20).map((m, i) => id(m, `${where}.mediaAssetIds[${i}]`)),
  };
}

/** One unreadable kanban never blocks the others: they are reported individually. */
export function parseKanbans(raw: unknown): { kanbans: BackupKanban[]; invalid: { partCode: string; error: string }[] } {
  const list = arr(raw, 'kanbans.json', 1_000_000);
  const kanbans: BackupKanban[] = [];
  const invalid: { partCode: string; error: string }[] = [];
  list.forEach((item, i) => {
    try {
      kanbans.push(parseKanban(item, `kanban ${i + 1}`));
    } catch (e) {
      const code = item && typeof item === 'object' && typeof (item as Obj).partCode === 'string' ? ((item as Obj).partCode as string) : `#${i + 1}`;
      invalid.push({ partCode: code, error: e instanceof Error ? e.message : String(e) });
    }
  });
  return { kanbans, invalid };
}
