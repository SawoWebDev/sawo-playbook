# ADR 0002 — Foundation choices (Phase 0)

- **Status:** Accepted — 2026-09-30

1. **Pinned majors.** NestJS 11, Prisma 6, TypeScript 5.9, Next.js 15, React 19, Jest 29 — mature, well-supported majors rather than the newest releases (TS 7 / Prisma 7+ / Nest 12) to reduce integration risk.
2. **Docker-first.** Every service (Postgres 16, Redis 7, MinIO, Gotenberg, API, Web) runs via `docker-compose.yml`. Tests run in the `api-test` service against a dedicated `gembadocs_test` database.
3. **`organization_id` on every tenant table**, including child tables (`sop_version`, `sop_step`, approvals, skills, checklists). This lets every repository query filter by tenant directly (Invariant #10) without joins. It is always copied from the authenticated principal, never from input (Invariants #2, #15).
4. **Authorization guard** (`AuthorizationGuard`, global): deny-by-default — each route must declare `@Public()` or `@RequirePermission()`; a test enumerates all routes to enforce this. The JWT is verified with `@nestjs/jwt`, then the user row is re-read so that status, role, org status and `token_version` are authoritative. Passport packages remain installed for the pluggable SSO strategies (Phase 0.5 stub); the JWT contract is unchanged.
5. **Access-token revocation** uses `app_user.token_version` embedded as the `tv` claim. `TokenService.revokeAllForUser()` bumps it and revokes all refresh families — used on password reset, role change, suspension and removal (§7.3 rule 7).
6. **Refresh cookie** `playbook_rt`: HttpOnly, SameSite=Strict, `Secure` outside local dev, `Path=/api/auth/refresh` (logout is `POST /api/auth/refresh/logout` so the cookie reaches it).
7. **Immutability triggers** in SQL: `audit_log`, `activity_event`, `sop_version_approval` (UPDATE/DELETE) and `skill_assessment` (UPDATE) are blocked. DELETE is only possible inside a transaction that sets `gemba.allow_purge = 'on'` — reserved for the documented purge workflow (§7.7, §13).
8. **Single-origin web app.** Next.js rewrites `/api/*` to the API container, so the browser talks to one origin and the SameSite=Strict refresh cookie works without CSRF tokens (§7.4).
9. **Email is globally unique** on `app_user` because multi-org membership is deferred (§18).
