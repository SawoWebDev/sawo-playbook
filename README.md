# GembaDocs

Multi-tenant platform for operations teams: versioned SOPs with approval workflow,
QR/PDF sharing, checklists, kanban cards, skills matrix, folders and analytics.

- Specification: [GembaDocs-System-Build-Plan-FINAL.md](GembaDocs-System-Build-Plan-FINAL.md)
- Build progress / session hand-off: [TASK_TRACKER.md](TASK_TRACKER.md)
- Decisions: [docs/decisions](docs/decisions) · Security: [docs/security-checklist.md](docs/security-checklist.md)

## Stack
NestJS 11 + Prisma 6 (PostgreSQL 16) · Next.js 15 · Redis 7 + BullMQ · MinIO (S3) · Gotenberg 8 (PDF) — all in Docker.

```
apps/api   NestJS REST API (/api/*), BullMQ worker (src/worker.ts), Prisma schema + migrations
apps/web   Next.js app; proxies /api/* to the API so the browser sees one origin
```

## Run locally (Docker)
```bash
docker compose up -d --build      # db, redis, minio, gotenberg, api, worker, web
open http://localhost:3000        # create an organization via "Create an account"
```
Ports can be changed with `GEMBA_WEB_PORT`, `GEMBA_API_PORT`, `GEMBA_DB_PORT`, `GEMBA_REDIS_PORT`, `GEMBA_MINIO_PORT`, `GEMBA_PDF_PORT`.
Invitation / password-reset links are printed in the `api` container log (`docker compose logs api`) until SMTP is configured.

## Tests
```bash
docker compose --profile test run --rm api-test                         # full suite
docker compose --profile test run --rm -e TEST_ARGS=sops api-test       # one file
```
The suite includes the standing gates required by the spec: cross-tenant isolation for every module,
published-version immutability at all three layers, the Invariant #19 concurrency test and approval-round isolation.

## Production
```bash
cp .env.example .env    # set POSTGRES_PASSWORD, JWT_ACCESS_SECRET, S3_*, PUBLIC_APP_URL, S3_PUBLIC_ENDPOINT
docker compose -f docker-compose.prod.yml up -d --build
```
Put a TLS-terminating proxy in front of `web` (port 3000) and MinIO (`S3_PUBLIC_ENDPOINT`).
