export type SopStatus = 'draft' | 'pending_approval' | 'approved' | 'published' | 'archived';
export type VersionState = 'DRAFT' | 'PENDING_PRE_APPROVAL' | 'PENDING_APPROVAL' | 'APPROVED' | 'PUBLISHED' | 'ABANDONED';
export type SopType = 'standard' | 'advanced' | 'video' | 'document';

export interface UserRef {
  id: string;
  name: string;
}

export interface SopListItem {
  id: string;
  referenceNo: string;
  name: string;
  type: SopType;
  status: SopStatus;
  folder: { id: string; name: string } | null;
  createdAt: string;
  createdBy: UserRef | null;
  updatedAt: string;
  currentPublishedVersion: { id: string; versionSequence: number; label: string; publishedAt: string } | null;
  activeVersion: { id: string; label: string; lifecycleState: VersionState; approvals: number; quorum: number; rejected: boolean } | null;
}

export interface VersionSummary {
  id: string;
  versionSequence: number;
  label: string;
  lifecycleState: VersionState;
  changeSummary: string | null;
  currentApprovalRound: number;
  createdAt: string;
  submittedAt: string | null;
  approvedAt: string | null;
  publishedAt: string | null;
  createdByName?: string | null;
  publishedByName?: string | null;
}

export interface SopDetail {
  id: string;
  referenceNo: string;
  name: string;
  type: SopType;
  status: SopStatus;
  folder: { id: string; name: string } | null;
  createdAt: string;
  createdBy: UserRef | null;
  updatedAt: string;
  archivedAt: string | null;
  currentPublishedVersionId: string | null;
  activeVersionId: string | null;
  qrPublicToken: string;
  versions: VersionSummary[];
}

export interface MediaItem {
  id: string;
  type: 'image' | 'video' | 'pdf' | 'document';
  mimeType: string;
  originalFilename: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  url: string;
  displayOrder?: number;
}

export interface Step {
  id: string;
  order: number;
  title: string | null;
  description: string;
  isTextOnly: boolean;
  isCritical: boolean;
  usesOkNotokMedia: boolean;
  plannedTimeSeconds: number;
  linkedSop: { id: string; name: string; referenceNo: string } | null;
  linkedSopVersionId: string | null;
  media: MediaItem[];
}

export interface VersionConfig {
  cover_sheet: boolean;
  collaborate: boolean;
  checklist_sop: boolean;
  key_points_enabled: boolean;
  language: string;
  pdf_orientation: 'Landscape' | 'Portrait';
  steps_per_page: number;
  full_image: boolean;
  step_by_step_pdf: boolean;
  border_width: string;
  header_footer_color: string;
  header_footer_text_color: 'Black' | 'White';
  red_card_text: string;
  red_bg: string;
  red_text: 'Black' | 'White';
  green_bg: string;
  green_text: 'Black' | 'White';
  is_critical: boolean;
  video_link: string;
  total_time_required: string;
}

export interface VersionDetail {
  id: string;
  sopId: string;
  versionSequence: number;
  label: string;
  lifecycleState: VersionState;
  config: VersionConfig;
  changeSummary: string | null;
  currentApprovalRound: number;
  createdAt: string;
  createdBy: UserRef | null;
  submittedAt: string | null;
  submittedBy: UserRef | null;
  approvedAt: string | null;
  publishedAt: string | null;
  publishedBy: UserRef | null;
  cycleTimeSeconds: number;
  steps: Step[];
}

/** Approval stage of a pending SOP version. `pre` is Pre Approval, `final` is quorum approval. */
export type ApprovalStage = 'pre' | 'final';

/** Quorum progress exactly as GET /sops/:id/versions/:vid/approvals returns it. Never recomputed in the browser. */
export interface SopQuorum {
  required: number;
  current: number;
  remaining: number;
  eligibleApproverCount: number;
  availableApproverCount: number;
  currentUserApproved: boolean;
  currentUserCanApprove: boolean;
  stage: ApprovalStage;
}

/** What the current user may do with the version right now, as the server decided it. */
export interface SopActions {
  preApprove: boolean;
  approve: boolean;
  reject: boolean;
  publish: boolean;
}

export interface ApprovalHistory {
  versionId: string;
  label: string;
  lifecycleState: VersionState;
  /** Stage the version is waiting on, or null when it is not pending. */
  stage: ApprovalStage | null;
  currentApprovalRound: number;
  quorum: SopQuorum;
  /** True when an eligible Approver voted while Pre Approval was still pending (bypass). */
  preApprovalSkipped: boolean;
  preApprovalSkippedBy: string | null;
  submittedById: string | null;
  allowSelfApproval: boolean;
  routingGroups: { id: string; name: string | null }[];
  blocked: boolean;
  blockedReason: string | null;
  actions: SopActions;
  decisions: {
    id: string;
    round: number;
    stage: ApprovalStage;
    decision: 'approved' | 'rejected';
    comment: string | null;
    createdAt: string;
    approver: UserRef;
  }[];
}

/** Kanban revision lifecycle, as the Kanban API reports it. There is no Rejected or Blocked state: a rejection is a DRAFT with a comment. */
export type KanbanRevisionState = 'DRAFT' | 'PENDING_PRE_APPROVAL' | 'PRE_APPROVED' | 'APPROVED' | 'PUBLISHED' | 'DISCARDED';

/** One open revision in the Kanban approval inbox (GET /kanbans/revisions). Lists are already scoped to what this user can act on. */
export interface KanbanInboxItem {
  id: string;
  kanbanId: string | null;
  state: KanbanRevisionState;
  stage: ApprovalStage | null;
  partCode: string;
  partDescription: string | null;
  submitter: { id: string; name: string | null } | null;
  submittedAt: string | null;
  routingGroupIds: string[];
  comment: string | null;
  blockedReason?: string;
  /** The server's action flags for this revision for the caller, the same ones GET /kanbans/revisions/:rid returns. */
  actions: KanbanRevisionActions;
}

export interface KanbanInbox {
  preApproval: KanbanInboxItem[];
  finalApproval: KanbanInboxItem[];
  readyToPublish: KanbanInboxItem[];
  blocked: KanbanInboxItem[];
  rejected: KanbanInboxItem[];
  mine: KanbanInboxItem[];
}

/** The open revision of a card, on GET /kanbans and GET /kanbans/:id. Review state only; proposed fields need GET /kanbans/revisions/:rid. */
export interface KanbanOpenRevision {
  id: string;
  state: KanbanRevisionState;
  comment: string | null;
  submitter: { id: string; name: string | null } | null;
}

/** The workflow actions the server allows this user on one revision (GET /kanbans/revisions/:rid). Each is true only when the endpoint would accept it. */
export interface KanbanRevisionActions {
  submit: boolean;
  preApprove: boolean;
  approve: boolean;
  reject: boolean;
  publish: boolean;
}

/** One revision with its routed group names and the actions this user may take (GET /kanbans/revisions/:rid). */
export interface KanbanRevisionDetail {
  id: string;
  kanbanId: string | null;
  state: KanbanRevisionState;
  partCode: string;
  createdBy: UserRef | null;
  submittedById: string | null;
  submittedAt: string | null;
  preApprovedAt: string | null;
  approvedAt: string | null;
  routingGroups: { id: string; name: string | null }[];
  lastComment: string | null;
  updatedAt: string;
  actions: KanbanRevisionActions;
}
