# Security checklist (Phase 10 — spec §7.3, §7.8, §8, §10)

Status of each requirement, with where it is enforced and which test proves it.

| # | Requirement | Status | Where | Test |
|---|---|---|---|---|
| 1 | Never trust client for role/scope/`organization_id` | ✅ | `AuthorizationGuard` re-reads user; services take `actor.organizationId`; DTO whitelist rejects unknown fields | `auth.e2e` (whitelist), every cross-tenant suite |
| 2 | Every route declares a permission (deny by default) | ✅ | `@Public()` / `@RequirePermission()` + global guard | `authorization.e2e` enumerates all routes |
| 3 | Resource-level checks | ✅ | tenant-scoped `findFirst` in each service → 404 | `*.e2e` cross-tenant blocks |
| 4 | Field-level Skills rules | ✅ | `SkillsService.visibleAssociates/assertCanAssess` | `skills.e2e` |
| 5 | Approval state machine server-side, self-approval, separate publish | ✅ | `SopWorkflowService` | `sops.e2e` |
| 6 | Rate limiting & lockout on auth | ✅ | `@nestjs/throttler` (10/min auth, 120/min global); 5 failures → 15 min lock | `auth.e2e` lockout |
| 7 | Token invalidation on password reset / role change / removal / suspension | ✅ | `TokenService.revokeAllForUser` (+ `token_version` claim) | `auth.e2e`, `users.e2e` |
| 8 | Least privilege for API keys/integrations | n/a | No API keys exist in MVP | — |
| 9 | Org id from authenticated session only | ✅ | see #1 | — |
| — | IDOR/BOLA | ✅ | tenant-scoped lookups; media ids validated with `MediaService.assertUsable` before attach | `sops.e2e`, `kanbans.e2e`, `checklists.e2e` |
| — | Signed, time-limited media URLs | ✅ | `StorageService.signedUrl` (10 min), bucket private | `sops.e2e` media |
| — | Upload MIME/size validation | ✅ | magic-byte sniffing, allow-list, 20–25 MB caps (`media/file-sniff.ts`) | `sops.e2e` disguised upload |
| — | Malware scanning | ✅ | clamd INSTREAM scan on every upload when `CLAMAV_HOST` set (on in prod compose); fail closed | `malware.e2e` |
| — | HTML sanitisation of rich text | ✅ | `sanitize-html` allow-list (`sops/sanitize.ts`); PDF/card templates escape all other values | `sops.e2e` |
| — | Secure headers | ✅ | API: `helmet`; Web: X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy, CSP (production) | manual |
| — | Encryption at rest | ⏳ | Infrastructure concern: encrypted volumes for Postgres/MinIO; MinIO SSE-KMS in production | — |
| — | No committed secrets | ✅ | `.env` git-ignored; prod compose requires secrets via `${VAR:?}` | — |
| — | MFA (TOTP) | ✅ | RFC 6238, AES-256-GCM encrypted secrets, replay protection, lockout counting, admin reset (`auth/totp.ts`) | `mfa.e2e` |
| — | Tested backups | ✅ | `scripts/backup.sh` / `scripts/restore.sh`; restore drill run 2026-09-30 (schedule via host cron) | manual drill |
| — | Refresh token: hashed, rotated, reuse detection, HttpOnly/Secure/SameSite=Strict, path-scoped | ✅ | `TokenService`, `auth.controller.ts` | `auth.e2e` |
| — | CSV export formula injection | ✅ | `csvCell()` prefixes `= + - @` | `kanbans.e2e` |
| — | Open redirect on login `?next=` | ✅ | same-origin relative paths only (`login/page.tsx`) | manual |
| — | Immutable audit log | ✅ | DB trigger; delete only in purge workflow | `schema.e2e` |
| — | Published-version immutability (3 layers) | ✅ | service → `SopVersionRepository` → DB triggers | `sops.e2e` (mandatory suite) |
| — | Tenant isolation regression gate | ✅ | full suite runs in CI (`.github/workflows/ci.yml`) on every push/PR | all `*.e2e` |

## Open items
2. Nonce-based CSP to drop `'unsafe-inline'` for scripts.
4. Schedule `scripts/backup.sh` on the production host and repeat restore drills.
5. Encryption at rest configuration for the target hosting environment.
