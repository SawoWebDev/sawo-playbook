# SAWO Playbook

Multi-tenant platform for operations teams: versioned SOPs with approval workflow,
QR/PDF sharing, checklists, kanban cards, skills matrix, folders and analytics.

- Specification: [SAWO-Playbook-System-Build-Plan-FINAL.md](SAWO-Playbook-System-Build-Plan-FINAL.md)
- Build progress / session hand-off: [TASK_TRACKER.md](TASK_TRACKER.md)
- Decisions: [docs/decisions](docs/decisions) · Security: [docs/security-checklist.md](docs/security-checklist.md)

## Stack
NestJS 11 + Prisma 6 (PostgreSQL 16) · Next.js 15 — three Docker containers (db, api, web). Uploads are stored on a Docker volume; SOP and kanban PDFs are rendered in the API container by headless Chromium (no separate PDF service).

```
apps/api   NestJS REST API (/api/*), Prisma schema + migrations
apps/web   Next.js app; proxies /api/* to the API so the browser sees one origin
```

## Run locally (Docker)
```bash
docker compose up -d --build      # db, api, web
open http://localhost:3000        # create an organization via "Create an account"
```
Ports can be changed with `GEMBA_WEB_PORT`, `GEMBA_API_PORT`, `GEMBA_DB_PORT`.
Without `SMTP_URL`, invitation / password-reset emails are printed in the API log (`docker compose logs api`).

## Tests
```bash
docker compose --profile test run --rm api-test                         # full suite
docker compose --profile test run --rm -e TEST_ARGS=sops api-test       # one file
```
Browser (Playwright) tests against the running stack, using a production build of the web app:
```bash
docker compose --profile e2e up -d --build web-e2e
docker compose --profile e2e run --rm e2e                                   # 17 UI tests
E2E_REVIEW=1 docker compose --profile e2e run --rm -e E2E_ARGS="--grep @review" e2e   # screenshot tour → e2e/review/
```
The API suite includes the standing gates required by the spec: cross-tenant isolation for every module,
published-version immutability at all three layers, the Invariant #19 concurrency test and approval-round isolation.

## Production
```bash
cp .env.example .env    # set POSTGRES_PASSWORD, JWT_ACCESS_SECRET, MFA_ENCRYPTION_KEY, PUBLIC_APP_URL, SMTP_URL
docker compose -f docker-compose.prod.yml up -d --build
```
Put a TLS-terminating proxy in front of `web` (port 3000).

The Owner account from the test organization:
Email: owner-munottnvqye@e2e.test
Password: correct-horse-battery-staple