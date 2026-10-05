# SOP Management System — Master Build Specification

> This is the complete, self-contained build specification. It requires no
> other document to be read alongside it. No further architectural review is
> expected before Phase 0 — remaining open items are business-policy
> decisions (Section 18), not design gaps. No billing/subscription layer
> exists anywhere in this system — access is purely role-based.

---

## 0. Classification Legend

| Tag | Meaning |
|---|---|
| **[OBSERVED]** | Directly visible in the reference screenshots; describes the reference product, not necessarily a requirement. |
| **[REQUIRED]** | Binding requirement for our system. |
| **[ASSUMED]** | Inferred but unconfirmed — validate with stakeholder (Section 19). |

---

## 1. Domain Invariants — NON-NEGOTIABLE — [REQUIRED]

These override any other section if a conflict is ever found.

1. Every tenant-owned resource belongs to exactly one Organization.
2. `organization_id` is always derived from authenticated context, never from client input.
3. Published SOPVersions are immutable (Steps, config, media references cannot change).
4. Editing a published SOP always creates a new SOPVersion — never an in-place mutation.
5. A physical QR identifies the stable **SOP** (`SOP.qr_public_token`), not a specific version; it resolves to the SOP's current published version at scan time.
6. Historical `ChecklistSubmission` and historical PDFs reference the exact `sop_version_id` executed/rendered, regardless of what the SOP's current published version later becomes.
7. Historical `SkillAssessment` records reference the exact `sop_version_id` assessed against.
8. AI-generated or document-parsed SOP content is always draft-only — never auto-published.
9. QR scanning never grants authorization by itself; editing always requires an authenticated, permission-checked session.
10. No user can access or mutate another organization's resources (enforced at query level, tested explicitly — Section 8).
11. `AuditLog` records are immutable and are the authoritative compliance/security record.
12. A `MediaAsset` referenced by any retained published SOPVersion is never physically deleted.
13. No business record is hard-deleted outside the documented purge workflow (Section 13).
14. Approval requires a quorum of **distinct, eligible** approvers; by default the submitter of a version cannot approve that same version (Section 6.3).
15. Client-provided `organization_id` (or any other tenant-scoping field) is never trusted — always re-derived server-side.
16. Historical actor references (`created_by`, `approved_by`, `trainer_id`, `actor_id`) never disappear even after the referenced user account is removed (Section 7.1).
17. Only approval decisions from the current `approval_round` contribute to quorum. Decisions from previous rounds remain immutable historical records and are never deleted or reused for counting.
18. `SOPVersion.lifecycle_state` is authoritative. `SOP.status` is a derived, denormalized convenience field, never written independently — it is recomputed transactionally per the precedence rule in Section 6.2.
19. An SOP may have **at most one active unpublished version** at any time (`lifecycle_state ∈ {DRAFT, PENDING_APPROVAL, APPROVED}`), **enforced atomically at the database level** (Section 6.3), not merely by an application-layer pre-check — this prevents two concurrent requests from both passing a "does an active version already exist?" check and creating duplicate drafts.
20. Approver eligibility is evaluated at the moment a decision is submitted. A decision valid when made remains valid and counts toward quorum even if the approver's role changes afterward; a user who loses Approver status before voting simply cannot submit a new decision.
21. A `ChecklistSubmission` always executes against the exact published `SOPVersion` selected when the session starts; publishing a newer version never alters an in-progress or completed submission's `sop_version_id` or its responses.

---

## 2. What We're Building — [REQUIRED]

A multi-tenant web platform for manufacturing/operations teams to create,
version, and publish SOPs; maintain a parts catalog ("Kanbans"); track
workforce competency ("Skills Matrix") against specific SOP versions;
organize content in folders; and share via QR/PDF/link with analytics.

---

## 3. Core Modules — [REQUIRED]

| Module | Purpose |
|---|---|
| **STD OPS** | Create/version/approve/publish/view SOPs |
| **KANBANS** | Parts/components card catalog |
| **SKILLS** | Skills matrix / training tracker, version-aware |
| **FOLDERS** | Organize SOPs into a tree |
| **Analytics** | Usage/creation stats derived from ActivityEvent |
| **User Management** | Accounts, roles, scopes, invitations, audit log |

---

## 4. Detailed Feature Breakdown

### 4.1 STD OPS List/Grid View
- **[OBSERVED]** Card grid: Procedure Name, Reference No., Folder, Date Raised, Created By, Last Modified.
- **[OBSERVED]** "+ Create New": Standard SOP, Video SOP, Advanced SOP, Upload Document.
- **[OBSERVED]** Status badges (e.g. "Rejected", "0/3 Approved").
- **[REQUIRED]** The approver quorum is an org-configurable integer stored in `OrganizationSettings.approval_quorum` (Section 6.1a).

### 4.2 SOP Editor
- **[OBSERVED]** Configuration toggles: Cover Sheet, Collaborate, Checklist SOP, Advanced Options → Key Points.
- **[REQUIRED]** Editing a published SOP always opens a new draft SOPVersion (copy-on-write), subject to the one-active-unpublished-version invariant (#19).

### 4.3 SOP Detail / Viewer
- **[OBSERVED]** Time badges, View/Print/Share panels, QR, Green/Red QR variant **[ASSUMED pass/fail signage — confirm]**.
- **[REQUIRED]** "Scan To Edit" never grants edit access by itself — Section 5.

### 4.4 KANBANS
- **[OBSERVED]** Grid, bulk import/print/edit, filter/sort.
- **[REQUIRED]** Ordering fields normalized (Section 6.7).

### 4.5 SKILLS
- **[REQUIRED]** Core module, no gating.
- **[OBSERVED / corrected]** 5 competency states, integer values 0–4.
- **[REQUIRED]** Full history via `SkillAssessment` (Section 6.8).

### 4.6 Analytics
- **[REQUIRED]** Backed by `ActivityEvent`, distinct from `AuditLog` (Section 6.9).

### 4.7 Folders / 4.8 Global Chrome — unchanged, **[OBSERVED]**.

---

## 5. QR Code & Public-Access Architecture — [REQUIRED]

```
Printed QR
   ↓ encodes
https://app.example.com/s/{sop.qr_public_token}
   ↓
Public resolver endpoint → look up SOP by qr_public_token
   ↓
Branch on intent:
  - VIEW  → resolve SOP.current_published_version_id → render that SOPVersion
  - EDIT  → require login + permission check → open a NEW draft SOPVersion
             (copy-on-write; subject to Invariant #19)
```
`SOP.qr_public_token` is stable, opaque, non-guessable — never a primary
key. Historical immutability is preserved via `sop_version_id` pins on
`ChecklistSubmission` and rendered PDFs (Invariants #5, #6), not by the QR
itself. Green/Red QR (**[ASSUMED]**) reuses the same resolver — a visual
affordance only.

---

## 6. Data Model

### 6.1 Organization & Tenancy — [REQUIRED]
```
Organization (tenant)
 ├─ id, name, status [active|suspended|pending_deletion|deleted]
 ├─ Sites[] — NOT ACTIVE IN MVP (Section 6.10)
 └─ Users[] → Section 7
```

### 6.1a OrganizationSettings — [REQUIRED]
```
OrganizationSettings
 ├─ organization_id (PK, FK → Organization.id)
 ├─ approval_quorum INTEGER         (default: 3)
 ├─ allow_self_approval BOOLEAN     (default: false)
 ├─ public_sop_viewing BOOLEAN      (default: false)
 └─ updated_at
```
Created with defaults at org signup. Future org-level toggles (e.g. a
configurable deletion cooldown length) are added here, not scattered.

### 6.2 SOP (stable identity + QR anchor) — [REQUIRED]
```
SOP
 ├─ id
 ├─ organization_id
 ├─ reference_no
 ├─ name
 ├─ type [standard | advanced | video | document]
 ├─ folder_id (nullable)
 ├─ qr_public_token (unique, opaque)
 ├─ current_published_version_id (nullable)
 ├─ latest_draft_version_id (nullable)   ← read as "latest active unpublished version" (Invariant #19)
 ├─ status [draft | pending_approval | approved | published | archived]  ← DERIVED, see rule below
 ├─ created_by, created_at
 └─ deleted_at, deleted_by (nullable)
```
**`SOP.status` derivation rule (Invariant #18):** recomputed transactionally
whenever `SOPVersion.lifecycle_state` changes, using this precedence:
```
archived           if the SOP itself has been archived
pending_approval   if the active unpublished version is PENDING_APPROVAL
approved           if the active unpublished version is APPROVED (not yet published)
draft              if the active unpublished version is DRAFT
published          if there is no active unpublished version and current_published_version_id is set
```
Application code never writes `SOP.status` directly outside this
recomputation path.

### 6.3 SOPVersion (immutable once published) — [REQUIRED]
```
SOPVersion
 ├─ id
 ├─ sop_id
 ├─ version_sequence INTEGER          (monotonic per SOP; display-formatted "1.001", "1.002", ...)
 ├─ config: { cover_sheet, collaborate, checklist_sop, key_points_enabled }
 ├─ lifecycle_state [DRAFT | PENDING_APPROVAL | APPROVED | PUBLISHED | ABANDONED]
 ├─ current_approval_round INTEGER    (starts at 1; increments on reject→resubmit)
 ├─ change_summary
 ├─ created_by, created_at
 ├─ submitted_by, submitted_at (nullable)
 ├─ approved_at (nullable)
 ├─ published_by, published_at (nullable)
 ├─ pdf_asset_id (→ MediaAsset, nullable until first render — the ONE canonical PDF for this version)
 └─ Steps[] → SOPStep
```

**Approval state machine:**
```
DRAFT
  │ submit (Owner/Admin/Editor)
  ▼
PENDING_APPROVAL
  ├─ reject (eligible Approver) ──► DRAFT (current_approval_round += 1 on next submit)
  └─ quorum reached in current_approval_round
        ▼
     APPROVED
        │ publish (Owner/Admin/Approver only — never Editor)
        ▼
     PUBLISHED   (immutable; SOP.current_published_version_id updated)
```
`ABANDONED` is a terminal state an active unpublished version can be moved
to explicitly (e.g. the author discards the draft), which frees the SOP to
start a new version per Invariant #19.

**Concurrency enforcement for Invariant #19 [REQUIRED]:**
> The "one active unpublished version" rule is enforced with a database
> constraint, not an application pre-check, so two concurrent
> create-draft requests cannot both succeed. Recommended mechanism for
> PostgreSQL — a partial unique index:
> ```sql
> CREATE UNIQUE INDEX one_active_unpublished_version
>   ON sop_version (sop_id)
>   WHERE lifecycle_state IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED');
> ```
> A second concurrent insert attempting to create another active version for
> the same `sop_id` fails the constraint; the application catches the
> constraint-violation error and returns a clear "an active version already
> exists" response rather than a generic 500.

**Self-approval rule:** the user in `submitted_by` cannot also record a
decision in `SOPVersionApproval` for the same version unless
`OrganizationSettings.allow_self_approval = true` (default `false`).

### 6.4 SOPVersionApproval — [REQUIRED, round-aware]
```
SOPVersionApproval
 ├─ id
 ├─ sop_version_id
 ├─ approval_round INTEGER
 ├─ approver_id
 ├─ decision [approved | rejected]
 ├─ comment
 └─ created_at

UNIQUE (sop_version_id, approval_round, approver_id)   -- DB-enforced, prevents double-voting in a round
```
**Quorum query:**
```sql
COUNT(DISTINCT approver_id)
WHERE decision = 'approved'
  AND approval_round = SOPVersion.current_approval_round
```
Approver eligibility is evaluated at decision time (Invariant #20).

### 6.5 SOPStep — [REQUIRED]
```
SOPStep
 ├─ id
 ├─ sop_version_id
 ├─ order
 ├─ title (Advanced SOP only)
 ├─ description (rich text)
 ├─ is_text_only, is_critical, uses_ok_notok_media
 ├─ linked_sop_id (nullable)              ← live link: current published version
 ├─ linked_sop_version_id (nullable)      ← historical pin: exact version
 └─ planned_time_seconds
```
Media is attached via `SOPStepMedia` (Section 6.6a), not an inline array.

### 6.6 MediaAsset — [REQUIRED]
```
MediaAsset
 ├─ id
 ├─ organization_id
 ├─ type [image | video | pdf | document]
 ├─ storage_key, original_filename, mime_type, size_bytes, checksum
 ├─ width, height, duration_seconds (nullable)
 ├─ lifecycle_state [uploaded | attached | referenced | orphaned | soft_deleted | purged]
 ├─ created_by, created_at
 └─ deleted_at (nullable)
```

**Lifecycle transitions [REQUIRED, full graph]:**
```
uploaded      → attached
attached      → referenced
attached      → orphaned
orphaned      → attached        (a new draft references it again)
orphaned      → soft_deleted    (grace period elapses, no new reference)
soft_deleted  → purged          (retention window elapses)
```
- `purged` is terminal.
- A `soft_deleted` asset may not be reused; a fresh `MediaAsset` is uploaded instead.
- `referenced → orphaned` fires whenever the last referencing record is deleted/superseded.
- If a published `SOPVersion` is eventually purged under retention policy,
  any `MediaAsset` it referenced is **re-evaluated** for orphan status at
  that point (it may still be referenced by a different retained version).

### 6.6a MediaAsset reference tables — [REQUIRED]
```
SOPStepMedia
 ├─ sop_step_id (FK)
 ├─ media_asset_id (FK)
 ├─ display_order
 └─ PRIMARY KEY (sop_step_id, media_asset_id)

KanbanMedia
 ├─ kanban_id (FK)
 ├─ media_asset_id (FK)
 └─ PRIMARY KEY (kanban_id, media_asset_id)
```
Orphan detection queries these tables plus `SOPVersion.pdf_asset_id` and
`Kanban.picture_asset_id` directly — never scans an array column.

### 6.7 Kanbans (ordering fields normalized) — [REQUIRED]
```
Kanban
 ├─ id, organization_id
 ├─ part_code, part_description, picture_asset_id (→ MediaAsset)
 ├─ supplier, supplier_part_no, used_for
 ├─ order_when, order_qty, delivery_time, location
 ├─ price, carriage (template-02 only)
 ├─ custom_field_1, custom_field_2
 ├─ ordering_type [url | sop | email]
 ├─ ordering_url (nullable)
 ├─ ordering_sop_id (nullable)
 ├─ ordering_email (nullable)
 │    constraint: exactly one of ordering_url / ordering_sop_id / ordering_email is non-null, matching ordering_type
 ├─ tag, color, barcode
 ├─ created_by, created_at
 └─ deleted_at (nullable)
```

### 6.8 Skills Matrix — current state + history — [REQUIRED]
```
SkillAssessment   ← durable historical record, never updated in place
 ├─ id
 ├─ associate_id
 ├─ sop_id
 ├─ sop_version_id
 ├─ level [0-4]
 ├─ trainer_id
 ├─ assessed_at
 └─ notes

SkillRecord       ← current-state projection, one row per associate+sop
 ├─ associate_id
 ├─ sop_id
 ├─ current_level [0-4]
 ├─ current_sop_version_id
 ├─ last_assessment_id (→ SkillAssessment)
 └─ updated_at
```
**Transaction rule [REQUIRED]:** the `SkillAssessment` insert
and the `SkillRecord` update happen in a single database transaction. If the
projection update fails, the assessment insert is rolled back. A separate,
explicitly-invoked repair operation may rebuild all `SkillRecord` rows from
full `SkillAssessment` history if drift is suspected.

5 competency states, values 0–4: No Training, Knows Basic Principles,
Demonstrates Basic Principles, Able to Work Alone, Able to Train Others.

### 6.9 ActivityEvent vs AuditLog — [REQUIRED]

| | `ActivityEvent` | `AuditLog` |
|---|---|---|
| Purpose | Analytics/usage/event-stream | Security, authorization, approvals, deletions |
| Authority | Not authoritative for compliance | **Authoritative compliance/security record** (Invariant #11) |
| Mutability | Append-only | Immutable, never purged on normal schedule |

Security-relevant events are written to both; `AuditLog` wins on disagreement.

### 6.10 Site & Folder Scope — MVP statement — [REQUIRED]
> MVP scope model is `Organization + Role` only. `site_scope[]`/
> `folder_scope[]` exist on `User` for forward-compatibility but are not
> enforced or referenced by any MVP resource; no MVP entity carries a
> `site_id`. Site/folder-scoped permission enforcement is a dedicated
> post-MVP phase, not partially implemented earlier.

### 6.11 ChecklistSubmission / ChecklistResponse — [REQUIRED]
```
ChecklistSubmission
 ├─ id, sop_version_id, operator_id
 ├─ started_at, completed_at, status [in_progress|completed|abandoned]
 └─ Responses[] → ChecklistResponse

ChecklistResponse
 ├─ id, submission_id, step_id
 ├─ value, result [ok|not_ok|n/a], comment
 ├─ media_asset_id (nullable), recorded_at
```
Execution-version pinning per Invariant #21.

---

## 7. User Management & Access Control (RBAC)

### 7.1 Account & Org Model — [REQUIRED]
```
Organization (tenant)
 └─ Users[]
      ├─ id, email, name, status [invited|active|suspended|removed]
      ├─ auth: password_hash | sso_provider_id
      ├─ org_role: [Owner, Admin, Editor, Approver, Trainer, Operator/Viewer]
      ├─ site_scope[], folder_scope[]   — schema present, NOT enforced in MVP
      └─ mfa_enabled, last_login_at, created_by
```
`Remove` never hard-deletes the user row (`status = removed`, login
blocked, row retained per Invariant #16).

### 7.2 Roles & Permission Matrix — [REQUIRED]

| Action | Owner | Admin | Editor | Approver | Trainer | Operator/Viewer |
|---|---|---|---|---|---|---|
| Invite/remove users | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Change a user's role | ✅ | ✅ (not Owner/Admin) | ❌ | ❌ | ❌ | ❌ |
| Create/edit Folders | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Create/edit SOPs (draft) | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Submit SOP version for approval | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Approve/Reject SOP version | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ |
| **Publish** an approved SOP version | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ |
| View published SOPs | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Complete a Checklist SOP | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Create/edit Kanbans | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Bulk Import/Print/Edit Kanbans | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| View/Update Skills Matrix cell | ✅ | ✅ | ❌ | ❌ | ✅ (their trainees) | own row only, read-only |
| Assign a Trainer | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| View Analytics | ✅ | ✅ | ✅ (own activity) | ❌ | ❌ | ❌ |
| Export/Share PDFs, QR codes | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (view/print only) |
| Request org deletion | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |

### 7.3 Server-Side Enforcement Rules — [REQUIRED]
1. Never trust the client for role/scope/`organization_id`.
2. Middleware-level guard on every route; no endpoint ships without a declared permission.
3. Resource-level checks, not just route-level.
4. Field-level restriction on Skills Matrix.
5. Approval state machine enforced server-side, including self-approval rule and separate publish step.
6. Rate limiting & lockout on auth endpoints.
7. Session/token invalidation on password reset, role change, or removal.
8. Least privilege for API keys/integrations.
9. Organization ID always derived from the authenticated session.

### 7.4 Authentication — JWT, locked — [REQUIRED]
> MVP authentication: short-lived JWT access token (memory-only on the
> client, never persisted) + a longer-lived, rotating refresh token stored
> server-side as a hash and delivered to the client as an `HttpOnly`,
> `Secure`, `SameSite=Strict` cookie scoped to the refresh endpoint only.

**Refresh-token rules [REQUIRED]:**
```
- stored server-side as a hash, never in plaintext
- rotated on every successful refresh; old token invalidated immediately
- reuse of an already-rotated token triggers reuse detection:
  the entire token family is revoked, forcing re-authentication
- password reset revokes all active refresh-token families for that user
- role change / removal revokes all active refresh-token families
```
Because the refresh token is not JavaScript-accessible and
`SameSite=Strict` blocks cross-site submission, standard CSRF mitigation is
added only if a future requirement introduces cross-site refresh calls — not
required for the MVP single-origin app. SSO (SAML/OIDC) later feeds the same
JWT contract as an alternate issuance path, not a parallel session mechanism.

### 7.5 Account Lifecycle & "Manage Users" UI — [REQUIRED]
User list, invite flow (single + bulk CSV), role change with immediate
session/token-family revocation, Suspend (reversible) vs Remove (permanent
login block, row retained), self-service profile.

### 7.6 Audit Logging — [REQUIRED]
See Section 6.9. Minimum logged events: login success/failure, password
reset, MFA change, user invited/role changed/suspended/removed, SOP version
submitted/approved/rejected/published, bulk Kanban import/edit, Skills
Matrix assessments, organization deletion requested/confirmed.

### 7.7 Organization Deletion — [REQUIRED]
```
Owner requests deletion → explicit confirmation (type org name) →
password/MFA re-auth → cooldown (proposed 14 days, cancellable) →
soft-delete (org.status=deleted; children flagged deleted_at) →
tenant data purge after standard retention —
EXCEPT records under an active compliance retention requirement
(e.g. AuditLog not yet past its confirmed window), retained until
that window elapses, then purged separately.
```

### 7.8 Additional Security Requirements — [REQUIRED]
IDOR/BOLA prevention, signed time-limited media URLs, upload MIME/size
validation, malware scanning where feasible, HTML sanitization on rich
text, secure headers, encryption at rest, no committed secrets, tested
backups.

---

## 8. Tenant Isolation — Foundation, Not Hardening — [REQUIRED]

Built in **Phase 0**, extended every phase after:
```
Phase 0:   Cross-tenant test harness exists.
Phase 1:   SOP/SOPVersion/SOPStep cross-tenant tests.
Phase 1.5: QR resolver + approval/publish cross-tenant tests.
Phase 4:   ChecklistSubmission cross-tenant tests.
Phase 6:   Kanban cross-tenant tests.
Phase 7:   SkillAssessment/SkillRecord cross-tenant tests.
Phase 10:  Full regression run — CI gate on every deploy.
```

---

## 9. API & System Architecture — [REQUIRED]
```
Web UI → REST API → Authorization middleware (role+scope+tenant) →
Application services → Repositories → PostgreSQL
```
Async (Redis + BullMQ): PDF generation, video processing, document
conversion, email delivery, analytics aggregation, MediaAsset orphan
cleanup (re-run after any published-version purge, Section 6.6).

---

## 10. Published-Version Immutability — Defense in Depth — [REQUIRED]
1. Application service rejects mutation on `PUBLISHED` versions.
2. Repository layer independently refuses the write.
3. Database trigger/check constraint rejects `UPDATE`/`DELETE` on `SOPStep`
   rows whose parent version is `PUBLISHED`, where practical.
4. Mandatory regression test: attempting such an update must fail at every
   layer — always-run, not optional.

---

## 11. Video SOP Subsystem — [REQUIRED]
```
Video Upload → Transcoding → Audio extraction → Scene detection →
Candidate step segmentation → AI-generated descriptions → Human review
(required) → SOP draft (DRAFT) → normal approval workflow
```
AI output is always draft-only (Invariant #8). **[ASSUMED]** Chrome-plugin
capture optional for v1; direct upload is the MVP path.

## 12. Document Conversion — [REQUIRED]
```
Uploaded document → Parser → Extracted content → SOP draft (DRAFT) →
Human verification → normal approval workflow
```
Same draft-only rule as Video SOP.

---

## 13. Deletion & Archive Policy — [REQUIRED]
No business record is hard-deleted by default. Published SOPVersions are
archived, never deleted, queryable per retention policy. `MediaAsset`
lifecycle (Section 6.6) governs cleanup of truly orphaned assets.
Organization deletion follows Section 7.7, including the compliance-record
carve-out.

---

## 14. Search — [REQUIRED]
PostgreSQL FTS for MVP. **SOP fields:** name, reference_no, step title, step
description, folder name. **Kanban fields:** part_code, part_description,
supplier, supplier_part_no, used_for, tags. Soft-deleted records excluded.
Search returns current-published-version content by default; drafts appear
only to users with `Create/edit SOPs` permission within their own org.
`tsvector` updated synchronously on write.

---

## 15. Locked Technology Stack — [REQUIRED]

| Layer | Choice |
|---|---|
| Frontend | Next.js + TypeScript |
| Backend | NestJS + TypeScript |
| Database | PostgreSQL |
| Object Storage | S3-compatible |
| Queue | Redis + BullMQ |
| Authentication | JWT access + rotating refresh token (HttpOnly cookie), NestJS Passport JWT strategy |
| PDF rendering | Selected and pinned as a **Phase 0 exit criterion** |
| Video processing | FFmpeg + selected library, pinned as a **Phase 3 entry criterion** |
| Deployment | Docker, environment-per-stage |

---

## 16. Build Process — Phased Plan

### Phase 0 — Architecture / Foundation
1. Repository, CI, environments, Docker.
2. Full schema migrations: Organization, OrganizationSettings, User, SOP,
   SOPVersion, SOPVersionApproval, SOPStep, SOPStepMedia, MediaAsset,
   Kanban, KanbanMedia, SkillAssessment, SkillRecord,
   ChecklistSubmission/Response, ActivityEvent, AuditLog.
   **Migrations create structural tables/relationships only — no feature
   behavior, endpoints, UI, jobs, or workflows are implemented here even
   though their tables exist** (avoids an implementer building
   Checklist/Kanban/Skills functionality prematurely just because the
   tables are present).
3. Tenancy + authorization middleware; JWT auth mechanism (7.4) implemented.
4. Cross-tenant test harness stood up (Section 8).
5. Database-level enforcement of Invariant #19 (partial unique index, Section 6.3) implemented and tested.
6. Migration/DB tests for: approval-round isolation, approval uniqueness,
   `OrganizationSettings` defaults, active-unpublished-version concurrency,
   media join tables.
7. Refresh-token persistence/rotation rules verified (7.4).
8. **Exit criterion: PDF renderer selected and documented.**

### Phase 0.5 — User Management & Auth
Signup/Owner creation, invite flow, "Manage Users" UI, role matrix
enforcement, audit log wiring, SSO stubbed as pluggable only.

### Phase 1 — SOP MVP
SOP + SOPVersion + SOPStep + SOPStepMedia + MediaAsset live end-to-end;
list/grid view; Standard SOP editor; viewer for a specific version; PDF
export using the pinned renderer. Cross-tenant tests added.

### Phase 1.5 — SOP Governance
1. Full approval state machine with round-aware `SOPVersionApproval`,
   configurable quorum (`OrganizationSettings.approval_quorum`), and
   self-approval rule enforced.
2. Publish as a distinct action/permission from Approve.
3. Published-version immutability at all three layers + mandatory
   regression test.
4. QR generation + resolver on `SOP.qr_public_token`; QR cross-tenant tests.
5. Apply Patches 9–12 (behavioral invariants #20, #21, skill-projection
   transaction rule, media lifecycle transitions) and add tests for each
   before this phase is considered done.
6. Must land before Kanbans/Skills/Checklist depend on "the SOP" concept.

### Phase 2 — Sharing & Print
Green/Red QR variant (pending confirmation), share panel, kiosk mode.

### Phase 3 — Advanced SOP, Video SOP, Document Upload
**Entry criterion: video processing stack pinned.** Advanced SOP fields;
Video SOP subsystem; document conversion — both draft-only.

### Phase 4 — Checklist Submissions
`ChecklistSubmission`/`ChecklistResponse` referencing `sop_version_id`,
execution-version pinning (Invariant #21); cross-tenant tests added.

### Phase 5 — Folders
Folder CRUD, tree navigation, and filtering/search by folder, under the
`Organization + Role` MVP authorization model. Folder-based **permission**
enforcement (`folder_scope`) remains explicitly post-MVP (Section 6.10) —
this phase adds folder organization/navigation only, not folder-restricted
access control.

### Phase 6 — Kanbans
CRUD, normalized ordering fields, `KanbanMedia`, bulk import/print/edit
(role-gated, no plan gating), filter/sort; cross-tenant tests added.

### Phase 7 — Skills Matrix
`SkillAssessment` + `SkillRecord` (single-transaction rule enforced); matrix
grid UI (5 states, 0–4); training history from `SkillAssessment`;
cross-tenant tests added.

### Phase 8 — Analytics & Search
`ActivityEvent` emission across all write paths; aggregation + dashboard UI;
PostgreSQL FTS per Section 14.

### Phase 9 — Marketing / Info Site (optional)
Landing page, localization.

### Phase 10 — Full Regression & Hardening
Full cross-tenant regression suite (CI gate), full security checklist pass,
mobile responsiveness, pagination/virtualized grids, deletion/archive policy
exercised end-to-end including the org-deletion compliance carve-out.

---

## 17. Acceptance Criteria & Testing — [REQUIRED]

Every feature: Requirement → Acceptance Criteria → Test Cases. Two mandatory
standing suites gate every deploy regardless of feature-level criteria:
- **Cross-tenant isolation suite** (Section 8).
- **Published-immutability regression test** (Section 10).

Also mandatory:
- **Concurrency test for Invariant #19**: fire two simultaneous "create
  draft" requests against the same SOP; exactly one must succeed, the other
  must fail cleanly on the partial unique index.
- **Approval-round isolation test**: reject a version, resubmit, confirm
  prior-round approvals do not count toward the new round's quorum.

### Worked example — Standard SOP creation
**Requirement:** A user with Editor+ permission can create an SOP with
multiple ordered steps.
**Acceptance Criteria:** creates `SOP` + `SOPVersion` (`version_sequence=1`,
`DRAFT`); steps addable/reorderable with media via `SOPStepMedia`; draft
save/reopen/edit; planned time in seconds, cycle time = sum; Operator → 403;
cross-org fetch → 404.

---

## 18. Business-Policy Decisions — Sequenced by What They Block

### Blocks Phase 0
- (none remaining — authentication mechanism resolved in 7.4)

### Blocks Phase 1.5
- Default approval quorum value (proposed 3 — confirm; stored in `OrganizationSettings`).
- Public vs. authenticated SOP viewing via View QR (`OrganizationSettings.public_sop_viewing` default `false` — confirm).
- Green/Red QR meaning (pass/fail signage) — confirm before building.

### Blocks Phase 3
- Video processing stack selection.
- Chrome-plugin capture requirement vs. upload-only for v1.

### Can be deferred
- SSO timing.
- Offline/mobile app access.
- Multi-org membership per user.
- Site/folder scope enforcement.
- Extensive marketing site.
- Audit log / soft-delete retention period exact duration (working assumption 3–7 years).
- Organization-deletion cooldown length (proposed 14 days).
- **Business deployment model** (sold as multi-tenant SaaS vs. run as one
  company's internal tool) — does not block Phase 0 architecture; the
  system is already built around `Organization` as the tenant boundary with
  full isolation, and running it for a single internal org is simply the
  `N=1` case of the same architecture.

---

## 19. Assets Note
All reference screenshots and future images/mockups/specs are kept **local
only**, stored in a local `/assets/reference` folder alongside this plan.

---

## 20. Immediate Next Step

Begin **Phase 0**: stand up the full schema (including `OrganizationSettings`,
round-aware `SOPVersionApproval`, `SOPStepMedia`/`KanbanMedia`, and the
partial unique index enforcing Invariant #19), the cross-tenant test
harness, and the JWT auth mechanism — structural only, no feature behavior
yet. No further architectural review is required before starting; the
remaining open items in Section 18 are business-policy decisions with
sensible defaults already specified, not design gaps. Proceed to Phase 0.5
→ Phase 1 → Phase 1.5 in sequence once Phase 0's exit criteria (schema,
harness, PDF renderer selection) are met.
