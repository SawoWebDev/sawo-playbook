export type SopStatus = 'draft' | 'pending_approval' | 'approved' | 'published' | 'archived';
export type VersionState = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'PUBLISHED' | 'ABANDONED';
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

export interface ApprovalHistory {
  versionId: string;
  label: string;
  lifecycleState: VersionState;
  currentApprovalRound: number;
  quorum: number;
  approvedInCurrentRound: number;
  submittedById: string | null;
  allowSelfApproval: boolean;
  decisions: { id: string; round: number; decision: 'approved' | 'rejected'; comment: string | null; createdAt: string; approver: UserRef }[];
}
