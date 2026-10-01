# GembaDocs — Build Task Tracker

> Source spec: [GembaDocs-System-Build-Plan-FINAL.md](GembaDocs-System-Build-Plan-FINAL.md)
> This file is the hand-off log between sessions. **Read "Resume Here" first.**
> Status legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked

---

## ▶ Resume Here (last stop)

- **Last updated:** 2026-09-30 — Session 1
- **Current phase:** Phase 10 — Full Regression & Hardening (Phase 3 blocked on video-stack decision; Phase 9 optional)
- **2026-09-30 SIMPLIFIED to 3 containers (db, api, web):** removed redis/BullMQ/worker (maintenance runs on a timer in the API; mail sent inline via SMTP_URL or logged), MinIO (uploads on `uploads` volume, HMAC-signed `/api/files/...` URLs), Gotenberg (SOP `/versions/:vid/print` + kanban `bulk/print` return PDFs rendered by headless Chromium (puppeteer-core) inside the api container; no canonical PDF stored), ClamAV/Mailpit (Mailpit only in `e2e` profile). API suite 184/184 green. Older notes below that mention Redis/MinIO/Gotenberg/worker are historical. `scripts/backup.sh`/`restore.sh` still reference MinIO and need updating; Playwright e2e not re-run.
- **Last completed step:** Phase 10 core done — BullMQ worker + retention/purge + media cleanup (4 tests), prod images + `docker-compose.prod.yml`, CSP, security checklist, README. **Full API suite 168/168 green**, `next build` clean.
- **Next action (pick up here):** Finish verifying the editor redesign + optional approval (API suites + Playwright incl. new `e2e/tests/editor.spec.ts`), then commit. Docker VM has only ~2 GB RAM: stop dev `web`/`worker` (`docker compose stop web worker`) before running test suites, start again after. Remaining: production deployment verification, CI first run, hardening. Business decisions pending: Phase 3 video stack, Green/Red QR.
- **Known issues / notes:** see "How to run" below. Initial commit `b095cff` on `main` (no remote configured). Full suite: 13 files / 179 API tests + 17 Playwright browser tests green.
- **Gotcha:** when editing files with Python on this Windows host always use `open(p, encoding='utf-8')` — the default cp1252 codec corrupted non-ASCII chars once (fixed).

### How to run (everything in Docker)
```bash
docker compose up -d --build                               # db, redis, minio, gotenberg, api(:4000), web(:3000)
docker compose --profile test run --rm api-test            # full API test suite against gembadocs_test DB
docker compose --profile test build api-test               # rebuild after package.json changes
```
- Host ports overridable: `GEMBA_DB_PORT, GEMBA_REDIS_PORT, GEMBA_MINIO_PORT, GEMBA_API_PORT, GEMBA_WEB_PORT, GEMBA_PDF_PORT`.
- New migration: edit `apps/api/prisma/schema.prisma`, then from `apps/api`:
  `DATABASE_URL=postgresql://x@localhost/x npx prisma migrate diff --from-schema-datamodel <old> --to-schema-datamodel prisma/schema.prisma --script`
  (or `docker compose run --rm api npx prisma migrate dev --create-only --name <name>`), append hand-written SQL if needed.
- Host `pnpm` is broken → each app has its own `package.json` + npm lockfile.

---

## Decisions Log

| Date | Decision | Reason / ADR |
|---|---|---|
| 2026-09-30 | Independent npm apps `apps/api`, `apps/web` (no workspaces) | pnpm broken; simpler Docker builds |
| 2026-09-30 | Pinned majors: Nest 11, Prisma 6, TS 5.9, Next 15, React 19, Jest 29 | stability — ADR 0002 |
| 2026-09-30 | `organization_id` denormalised onto every tenant table | direct tenant scoping — ADR 0002 |
| 2026-09-30 | Global deny-by-default `AuthorizationGuard` + `@RequirePermission` | §7.3 — ADR 0002 |
| 2026-09-30 | `token_version` claim for instant access-token revocation | §7.3 rule 7 — ADR 0002 |
| 2026-09-30 | **PDF renderer = Gotenberg 8 (Chromium)** — Phase 0 exit criterion | ADR 0001 |
| 2026-09-30 | Next.js rewrites `/api/*` → API (single origin) | SameSite=Strict cookie works |
| 2026-09-30 | MinIO image `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` | official minio/minio no longer published |
| 2026-09-30 | Orgs in `pending_deletion` remain usable (cooldown cancellable) | §7.7 |
| 2026-09-30 | Step content editable only in DRAFT (also frozen while PENDING/APPROVED) | approvers must approve what gets published |
| 2026-09-30 | Rejecting requires a comment; resubmit after reject increments round | §6.3/§6.4 |
| 2026-09-30 | `sanitize-html` pinned 2.17.0 (2.17.7 pulls ESM-only htmlparser2 that Jest can't load) | tooling |
| 2026-09-30 | PDF rendered synchronously on first request (BullMQ async queue deferred to Phase 8/10) | MVP simplicity |
| 2026-09-30 | Steps saved as whole ordered list (`PUT .../steps`), ids preserved when sent back | simple editor model |
| 2026-09-30 | Kanban CSV import is all-or-nothing (+ dryRun) | predictable bulk ops |
| 2026-09-30 | Nobody can assess their own skills; Trainers see self + trainees | conflict of interest; §7.2 "their trainees" |
| 2026-09-30 | **Approval workflow optional, off by default** (`approval_required`) — user's process has no approval | user decision, overrides spec §6.3 default |
| 2026-09-30 | Step description limit 400 characters (UI-enforced), hint above 120 | matches reference GembaDocs editor |

---

## Phase 0 — Architecture / Foundation ✅
- [x] 0.1 Repo scaffold, docker-compose (Postgres16, Redis7, MinIO, Gotenberg, api, web, api-test), CI workflow, .env.example
- [x] 0.2 Full schema — `apps/api/prisma/schema.prisma` + `migrations/20260930000000_init` (21 tables incl. Folder, Invitation, RefreshToken, TrainerAssignment)
- [x] 0.3 Global AuthorizationGuard, permission matrix (`src/common/permissions.ts`), JWT access + rotating refresh (`src/auth/*`)
- [x] 0.4 Cross-tenant harness `apps/api/test/harness.ts` (`createTenant`, `expectCrossTenantNotFound`)
- [x] 0.5 Partial unique index `one_active_unpublished_version` + concurrency test
- [x] 0.6 DB tests: round isolation, approval uniqueness/immutability, OrgSettings defaults, media join tables, kanban CHECK, skill level CHECK, audit immutability
- [x] 0.7 Refresh rotation / reuse detection / concurrent refresh / logout / revocation tests
- [x] 0.8 EXIT: PDF renderer — `docs/decisions/0001-pdf-renderer.md`
- [x] Web skeleton: login, signup, app shell with role-filtered nav

## Phase 0.5 — User Management & Auth ✅
- [x] Signup / Owner creation (+ OrganizationSettings defaults)
- [x] Login rate limit (throttler) + lockout (5 fails → 15 min)
- [x] Invite flow (single + bulk CSV), accept invite (`src/users/*`, web `/invite/[token]`)
- [x] Manage Users UI `/users` (list, role change, suspend/reactivate, remove, invitations)
- [x] Role rules (nobody grants OWNER; Admin can't touch/grant Admin; no self-change) + revokeAllForUser on role/suspend/remove
- [x] Self-service profile `/profile` (name, password change → revoke all + new session); forgot/reset password (mail outbox)
- [x] Org settings API/UI `/settings` (quorum 1–20, self-approval, public viewing)
- [x] Audit log viewer API/UI `/audit`
- [x] SSO pluggable stub (`src/auth/sso.ts`, `GET /api/auth/sso/providers`)
- [x] Org deletion request/cancel with 14-day cooldown (actual purge job → Phase 10)
- Note: MailService is a log+in-memory outbox; real SMTP via BullMQ later (Phase 8/10).

## Phase 1 — SOP MVP
- [x] API: SOP / SOPVersion / SOPStep / SOPStepMedia / MediaAsset (`src/sops/*`, `src/media/*`, `src/storage/*`)
- [x] Media upload (MinIO, magic-byte sniffing, 20–25 MB limits, signed URLs, IDOR check on attach)
- [x] PDF export via Gotenberg; canonical PDF stored once per PUBLISHED version (`src/sops/pdf.service.ts`)
- [x] Cross-tenant tests (`test/sops.e2e-spec.ts`)
- [x] Web: `/sops` grid (search, status filter, + Create New menu), editor `/sops/[id]/edit/[vid]` (rich text, media upload, reorder, toggles, link SOP), viewer `/sops/[id]` (versions, PDF)

## Phase 1.5 — SOP Governance
- [x] Approval state machine, round-aware approvals, quorum from settings, self-approval rule, reject requires comment
- [x] Publish separate permission; SOP.status derivation (`src/sops/sop-status.ts`, Invariant #18)
- [x] Immutability 3 layers: service (only DRAFT editable) → `SopVersionRepository` → DB triggers (migration `20260930020000_version_immutability`) + regression tests
- [x] QR token + resolver `GET /api/qr/:token` (+ `/image.png`); public view only if `public_sop_viewing`
- [x] Invariant #20 test, media lifecycle transitions (`src/media/media-lifecycle.ts`) + tests
- [ ] Invariant #21 (checklist pinning) test → with Phase 4; skill-projection txn test → with Phase 7
- [x] Web: approvals panel, submit/approve/reject/publish/discard buttons, share panel with QR, `/s/[token]` landing page, login `?next=` (same-origin only)

## Phase 2 — Sharing & Print
- [x] Share panel (QR image, copy link, download QR, print labels `/print/qr/[id]`)
- [x] Kiosk mode `/kiosk/[id]` (full screen, step-by-step, keyboard, auto-advance, auto-refresh to newest published version)
- [!] Green/Red QR variant — waiting on business confirmation (§18)

## Phase 3 — Advanced SOP, Video SOP, Document Upload
- [!] Entry criterion: video stack pinned (business decision §18)

## Phase 4 — Checklist Submissions ✅
- [x] API `src/checklists/*`: start (pinned to current PUBLISHED version, requires `checklist_sop` config), respond (OK/NOT OK/N/A, comment, photo evidence), complete (all steps answered), abandon
- [x] Visibility: Owner/Admin/Editor/Trainer see all; others only own; only starting operator may fill in
- [x] Tests: Invariant #21 pinning, cross-tenant (`test/checklists.e2e-spec.ts`); shared fixtures `test/sop-helpers.ts`
- [x] Web: `/checklists`, `/checklists/[id]` runner, "Start checklist" on SOP page
## Phase 5 — Folders ✅
- [x] API `src/folders/*`: list (with SOP counts), create, rename/move (cycle prevention via recursive CTE, max depth 10), soft-delete empty only; unique sibling names
- [x] SOP list `folderId` (+ `includeSubfolders=true`, `root`); SOP folder move via `PATCH /sops/:id`
- [x] Tests `test/folders.e2e-spec.ts` incl. cross-tenant
- [x] Web `/folders` tree (expand, subfolder, rename, move, delete); folder filter on `/sops` (`?folder=&sub=1`); folder picker in create + editor
## Phase 6 — Kanbans ✅
- [x] API `src/kanbans/*`: CRUD, ordering normalisation (service validation + DB CHECK), picture + KanbanMedia with media lifecycle, soft delete
- [x] List: search, tag/supplier/location filters, whitelisted sort, facets
- [x] Bulk (role-gated): CSV import all-or-nothing + dryRun (SOP ordering by reference no.), bulk edit, CSV export (formula-injection safe), print cards PDF (templates 01/02) via Gotenberg — audited
- [x] Tests `test/kanbans.e2e-spec.ts` incl. cross-tenant
- [x] Web `/kanbans`: card grid, filters/sort, selection → print/bulk edit, import dialog (validate→import), export, create/edit form
- Refactors: `src/common/csv.ts` (CSV parse/escape), `src/pdf/gotenberg.service.ts` (shared renderer client)
## Phase 7 — Skills Matrix ✅
- [x] API `src/skills/*`: matrix (published SOPs × active users, outdated flag when assessed on older version), history, assess, rebuild (repair from history), trainer assignments
- [x] Single-transaction rule: SkillAssessment insert + SkillRecord upsert + audit in one txn; test forces projection failure → insert rolled back
- [x] Visibility: Owner/Admin all; Trainer self + assigned trainees (assess trainees only); Operator own row read-only; no self-assessment
- [x] Tests `test/skills.e2e-spec.ts` incl. Invariant #7 + cross-tenant
- [x] Web `/skills`: matrix with quarter-circle level glyphs, assess dialog, trainer assignment admin, training history
## Phase 8 — Analytics & Search ✅
- [x] `ActivityService` + `@TrackActivity` decorator + global interceptor (emits after success, awaited); login written to AuditLog AND ActivityEvent; public QR views tracked
- [x] `GET /api/analytics/summary` (Owner/Admin org-wide, Editor own activity only): totals, per-event counts, daily series, top SOPs, top users
- [x] FTS migrations `20260930030000_full_text_search` + `20260930031000_fts_normalize_codes`: `sop.search_tsv` (trigger; folder rename refresh), `sop_version.content_tsv` (statement triggers on sop_step, HTML stripped), `kanban.search_tsv` (generated), GIN indexes; codes like `SOP-0002` normalised
- [x] `GET /api/search?q=` prefix queries; published content for all, draft content only for Editor/Approver+
- [x] Tests `test/analytics.e2e-spec.ts` (11) incl. cross-tenant
- [x] Web `/analytics` dashboard (tiles, stacked daily SVG chart, top lists), topbar search → `/search`
## UAT — Browser automation (Playwright)
- [x] `e2e/` project (Playwright 1.63, official Docker image), compose services `web-e2e` (production web build) + `e2e` (profile `e2e`), CI job `e2e`
- [x] Specs: `sop-journey` (signup → invites via Mailpit → SOP + step image → submit → 3-approver quorum, author blocked → publish → QR/labels/landing → checklist → kiosk → skills → new version), `auth` (validation, reset via email, ?next safety), `kanbans` (bulk import errors/success, filter, bulk edit, create), `mfa`, `navigation` (all pages, operator restrictions, folders, search, settings, analytics)
- [x] Fix found while preparing: API `trust proxy` now trusts private-network hops → real client IP for rate limiting + audit (was the web container IP for everyone)
- [x] Fix: "1 steps" pluralisation
- [x] Suite green: 17/17, run 4× (stable) against prod web build + running api/db/minio/gotenberg/mailpit
- [x] Real bug fixed: Settings page sent read-only `updatedAt` → API rejected every save (never worked from UI)
- [x] Test-side fixes: exact locators, wait for navigation after save, global setup waits for stack health, 24-char QR token parse
- [x] Visual pass via screenshot tour (`e2e/tests/visual-review.spec.ts`, `E2E_REVIEW=1 … --grep @review`, 23 screenshots desktop 1280 + phone 390)
- [x] Mobile fixes: page-level horizontal overflow on Users/Skills (tables now scroll in-box), squeezed topbar search (own row), nav labels wrapping, stretched mobile nav
- Known test-env limitation: signed MinIO image URLs use `localhost:9000`, unreachable from the Playwright container → images show as broken there only (verified reachable from host)
- **UAT status: PASSED** (functional automation + visual pass). Production deployment still unverified.
- Note: dev web server takes ~2 min per first page compile on this Windows bind mount → browser tests use the prod web build

## Change request (2026-09-30): editor layout + no-approval process
- [x] User decision: **their process has no approval step**. New org setting `approval_required` (migration `20260930050000_approval_optional`, default **false**). Off → "Finish & Save" publishes directly (`POST /api/sops/:id/versions/:vid/finish`, Editor+). On → existing submit/quorum/publish workflow (unchanged, still fully tested).
- [x] Settings page: "Require approval before publishing" switch; quorum/self-approval only shown when on
- [x] SOP page: Publish (direct) instead of Submit when approval off; Edit / Continue editing draft
- [x] Editor rebuilt to match the reference screenshot: header (Back · Edit Standard Operation · Cancel / Save As Draft / Finish & Save), name counter x/100 + saved check, SOP Configuration toggles (Cover Sheet / Checklist SOP / Advanced SOP), collapsible Advanced Options (ref no., folder, change summary, key points, collaborate), "Add Steps in to the procedure" + More Options (select all / mark critical / delete selected), per-step 3 columns (Photo/Video with replace/remove/drop, Description with B/I/U/colour/highlight/undo/redo/full-screen + 400-char limit, count and >120 orange PDF hint, toggles Text Only / OK-Not OK / Critical / Linked SOP, Planned Time HH:MM:SS), Move Down / Insert Step / Move Up, "+ Add New Step"
- [x] API: SOP type editable standard↔advanced; sanitizer keeps only `color`/`background-color` styles (tests added)
- [ ] Full API + Playwright verification, commit

## Phase 9 — Marketing site (optional)
- [ ] Not started (optional per spec)

## Phase 10 — Full Regression & Hardening
- [x] Cross-tenant regression suite runs on every push/PR (`.github/workflows/ci.yml` → `api-test` container)
- [x] Deletion/archive policy end-to-end: `src/jobs/maintenance.service.ts` (finalise after cooldown → soft delete; tenant purge after `TENANT_PURGE_RETENTION_DAYS` keeping AuditLog + org tombstone; compliance purge after `AUDIT_RETENTION_DAYS`; media orphan→soft_deleted→purged with S3 delete) + `test/maintenance.e2e-spec.ts`
- [x] BullMQ worker `src/worker.ts` (job scheduler, hourly) + `worker` service in both compose files
- [x] Production: `docker-compose.prod.yml` (prod targets, no bind mounts, required secrets), prisma CLI moved to dependencies, prod images verified to build
- [x] Web: production CSP + Permissions-Policy; SOP grid pagination (Load more, 48/page)
- [x] `docs/security-checklist.md`, `README.md`, `.env.example`
- [x] Mail via BullMQ `mail` queue → worker → nodemailer (`SMTP_URL`); Mailpit dev UI http://localhost:8025 (verified end-to-end)
- [x] Async canonical-PDF pre-render on publish (`pdf` queue, jobId `pdf-<versionId>`), inline fallback kept
- [x] `src/jobs/queue.service.ts` (queues disabled when NODE_ENV=test or `QUEUES_ENABLED=false`)
- [x] "Rejected" badge on SOP list cards (`activeVersion.rejected`)
- [x] `scripts/backup.sh` / `scripts/restore.sh` (pg_dump custom + MinIO tar + SHA256SUMS) — backup & restore drill passed on dev stack
- [x] ClamAV scan on upload (`src/media/malware-scanner.ts`, clamd zINSTREAM, fail-closed, `CLAMAV_FAIL_OPEN` override); dev compose profile `security`, on in prod — `test/malware.e2e-spec.ts` (fake clamd)
- [x] MFA (TOTP): migration `20260930040000_mfa`, `src/auth/totp.ts` (RFC 6238, AES-256-GCM secrets via `MFA_ENCRYPTION_KEY`), login step 2 `POST /api/auth/login/mfa` (5-min audience-bound token, replay protection, lockout counting), setup/enable/disable, admin reset `POST /api/users/:id/mfa/reset`; web login code step, profile enrolment (QR), Users "2FA" column + reset — `test/mfa.e2e-spec.ts` (8)
- [ ] Encryption-at-rest config for target host (infra)
- [ ] Nonce-based CSP (drop script 'unsafe-inline')
- [ ] Virtualised grids for very large orgs (pagination exists)

---

## Session History

### Session 1 — 2026-09-30
- Created tracker; user confirmed the system runs on Docker.
- Phase 0 completed: schema + constraints, auth, guard, harness, 50 tests passing in `api-test` container.
- Phase 0.5 completed: users/invitations/profile/password reset/org settings/audit/deletion + web pages. 79 tests.
- Phase 1/1.5 API completed: 118 tests (SOP CRUD, media, workflow, immutability ×3 layers, CoW, concurrency, QR, PDF, cross-tenant).
- Phase 1/1.5 web UI completed; placeholder pages for KANBANS/SKILLS/FOLDERS/Analytics.
- Phase 2, 4, 5, 6, 7, 8 and Phase 10 core completed in the same session (see phase sections).
- Phase 10 extras: mail queue + Mailpit, async PDF pre-render, Rejected badge, backup/restore scripts (drill passed), MFA (TOTP), ClamAV scanning.
- End of session state: 13 test files / 179 tests green; fresh `docker compose up -d --build` healthy; all web pages 200.
- Test count by suite: auth, authorization, schema, users, sops, checklists, folders, kanbans, skills, analytics, maintenance = 168.
- Full `docker compose up -d --build` verified (Docker Desktop occasionally returns `EOF` on container create — just re-run).

### Session 2 — 2026-10-01
- SAWO branding: logo (`public/assets/images/sawo-logo.webp`), tan header `#a97d53`, flat caramel buttons `#b0825e`, red accent `#c8454a`, Montserrat everywhere incl. SOP PDF and kanban print (`apps/api/src/pdf/brand.ts`).
- SOP detail page reworked (Edit + ⋮ menu with Versions/Details/Archive); View Step By Step moved into app layout (`(app)/kiosk/[id]`).
- Step images: same-size white 4:3 frames, no cropping, time badge above, pop-up `Lightbox`; editor image fixes.
- Kanbans list restyled like STD OPS (Create New menu, filter/sort icons, thumbnail tiles, ••• menu); API list/get now return `createdBy`.
- Pending: update `apps/api/src/pdf/sawo-logo.ts` to the new logo; run e2e profile (local Playwright browser download failed).
