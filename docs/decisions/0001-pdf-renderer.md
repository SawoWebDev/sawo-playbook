# ADR 0001 — PDF renderer (Phase 0 exit criterion, spec §15)

- **Status:** Accepted — 2026-09-30
- **Decision:** **Gotenberg 8** (`gotenberg/gotenberg:8`, headless Chromium) running as its own Docker service; the API renders SOP HTML server-side and POSTs it to `POST /forms/chromium/convert/html`.

## Context
SOP PDFs contain rich text (sanitised HTML), step images, OK/NOT-OK media, QR codes, cover sheets and key points. Every published `SOPVersion` gets exactly one canonical PDF (`SOPVersion.pdf_asset_id`, Invariant #6), generated asynchronously (BullMQ, §9) and stored in S3-compatible storage.

## Options considered
| Option | Fidelity | Ops cost | Notes |
|---|---|---|---|
| **Gotenberg (Chromium)** | High — same HTML/CSS as the web viewer | One extra container, stateless | Chromium isolated from API; horizontal scale by replicas |
| Playwright/Puppeteer inside API/worker | High | Chromium bundled into the Node image (~400 MB), sandboxing concerns | Couples API image to browser updates |
| pdfkit / pdfmake | Medium — manual layout code | Low | Duplicates layout logic; poor rich-text support |
| react-pdf | Medium | Low | Separate component tree to maintain; limited CSS |

## Consequences
- Templates are plain HTML + print CSS rendered by the API (shared styling with the web viewer).
- Image URLs embedded in the HTML are short-lived signed URLs reachable from the Gotenberg container (internal MinIO endpoint), or inlined as data URIs.
- Rendering runs in a BullMQ worker; the resulting `MediaAsset(type=pdf)` is referenced by `SOPVersion.pdf_asset_id`, keeping it alive under the media lifecycle rules (§6.6).
- Version pinned by major tag `:8`; pin to an exact digest before production.
- Security: Gotenberg is not exposed publicly in production (remove the host port mapping); only the API/worker can reach it.
