# Gemba Docs → sawo-gemba-docs SOP migration — progress

Goal: pull all 121 SOPs (metadata, steps, images) from the legacy gembadocs.com
account and recreate them in this app at http://localhost:3000.

## Status (update this each session)

| Stage | Done | Total | Notes |
|---|---|---|---|
| Pulled from gembadocs.com (JSON + images in `output/`) | 121 | 121 | complete, 0 errors, 0 slug collisions |
| Pushed into sawo-gemba-docs app (verified non-empty or legitimately-empty) | 121 | 121 | complete |
| Field fidelity (referenceNo, Created By, display order) | done | — | see below |
| Publish status (Draft vs Published matching gembadocs.com) | done | — | see below |
| Content verification (`node verify-content.js`) | 121 | 121 | 732 steps / 725 images checked, 0 problems (2026-10-05). Compares app vs. pulled JSON: step count, full step text (HTML entities decoded — the app stores `&` as `&amp;`), image presence per step, planned time. Paced for the 120 req/min throttle; waits out 429s. |

**Migration is complete as of 2026-10-05 (session 2).** All 121 SOPs from gembadocs.com are in the
app with matching Reference No, Created By (real original names, not the import account), display
order, and Draft/Published status. 14 of the 121 have no steps on gembadocs.com itself — 12 titled
"N/A" ("No step found.") plus "FOR PFC PURPOSES ONLY" and "FEED DEBUGGING MODE (CNC PANEL BENDER)" —
not a pull failure, verified by inspecting the live pages. They were imported as empty drafts at the
user's request, to match the source exactly rather than silently dropping them.

### Publish status
gembadocs.com's own list is a mix of published SOPs and ones marked "My Draft" — not everything is
published there. Scraped the real per-SOP status via `scrape-status.js` (checks each list card for
the `.text-warning` "My Draft" badge, saved to `output/.draft-status.json`), then `publish-all.js`
called the `/finish` endpoint (org has `approvalRequired: false`, so this publishes directly without
needing the approval workflow) for every SOP published on the source. Final result: 103 published,
18 draft (17 genuinely draft on the source + 1 that's published on gembadocs.com but has 0 steps —
our schema refuses to publish an empty version, so that one is a forced, unavoidable deviation).

### Field-fidelity notes
- **Reference No**: matches the original exactly for all 121. Two pairs of SOPs genuinely share
  the same reference number on gembadocs.com itself (refs "8" and "129", each used twice) — since
  our schema enforces per-org uniqueness, the second occurrence of each got a `-2` suffix.
- **Created By**: real `User` records were created in the org for each original creator (Amante
  Ornopia, Toni Kallioniemi, Process Team, Sop Creation), status `invited`, role `OPERATOR`, email
  `imported.<name>@gembadocs-import.local` — these are attribution-only placeholders, not meant to
  be logged into.
- **Date Raised** (`createdAt`): matches the original exactly.
- **Last Modified / display order**: our app's SOP list sorts by `updatedAt desc`; gembadocs.com's
  own list sorts by **Date Raised**, not Last Modified. Matching the *true* original Last Modified
  value would have reproduced the wrong order (confirmed empirically — tried it, order broke).
  So `updatedAt` was set to the same value as `createdAt` (Date Raised) for all 121, sacrificing
  exact Last Modified fidelity in favor of correct order, per explicit priority from the user.
  Order matches at day granularity; gembadocs.com only displays dates to day precision, so when
  several SOPs share the same Date Raised day, their relative order among themselves can't be
  recovered from the data available (confirmed: all mismatches found during verification were
  same-day adjacent pairs, not real misordering).
- These updates were applied via a one-off script run directly against the API container's Prisma
  Client (`docker compose exec api node scripts/one-off-import-fidelity.js`), since `createdAt`,
  `updatedAt`, and `createdById` aren't exposed through the public API — the script was deleted
  after running. To redo this for any future re-import, regenerate `fidelity-data.json` from
  `output/*.json` + `output/.pushed.json` (sourceUrl → app SOP id map) and recreate a similar
  script; see git history of this file for the exact script if needed.

### If gembadocs.com adds more SOPs later
Re-run `node pull-all.js` (resumes cleanly, only processes new ones), then
`node push-to-app.js` (no `--batch` needed now — dedup is by `sourceUrl` via `output/.pushed.json`,
safe to run unbounded). New SOPs won't automatically get the Created-By/date fidelity treatment —
rerun the fidelity script if that matters again.

## How to resume

1. Check pull progress: `ls output/*.json | grep -v manifest | wc -l`
2. If pull isn't finished: `node pull-all.js` (no `--limit`) — safe to re-run, skips nothing
   automatically, so only run once at a time. Writes one `<slug>.json` + images per SOP as it goes.
3. Push in phases (recommended batch size 10–15, see "Why phased" below):
   `node push-to-app.js --batch=15`
   - Skips SOPs that already exist in the app (matched by exact name).
   - Safe to re-run repeatedly until everything's pushed.
4. Verify a batch before moving to the next (see "Verifying" below).

## Scripts in this folder

- `lib.js` — shared Playwright login/launch helpers (uses real installed Chrome, not a downloaded
  Chromium — avoids the disk-space/corruption issues hit early in this session).
- `pull-all.js` — scrapes gembadocs.com STD OPS list + each SOP's detail page, downloads step
  images, writes `output/<slug>.json` + `output/images/<slug>/step-N.*`, and `output/manifest.json`
  (only written/flushed when a run *finishes*, so don't trust it mid-run).
  - `--limit=N` — stop after N SOPs (testing).
  - `--url=<href>` — retry a single SOP directly, skipping the list scroll (for stragglers that
    timed out).
- `push-to-app.js` — reads `output/*.json`, logs into the local app, creates each SOP via the API,
  uploads step images, saves steps. Dedups by exact name match. Cleans up (deletes) a SOP it
  partially created if a later step in the same push fails, so reruns can retry it cleanly.
  - `--batch=N` — push at most N *new* SOPs this run, then stop (already-pushed ones still get
    skipped instantly so this is cheap to re-run).
- `cleanup-orphans.js` — one-off/manual script, currently wired to find and delete broken (0-step)
  SOPs in the app. Rewrite its `ids`/logic as needed for whatever cleanup is needed next.

## Known issues hit this session (so we don't repeat them)

1. **Playwright's own Chromium download kept failing** (Windows Defender real-time scan stalling
   extraction, then a corrupted partial download, then a fully-full C: drive blocking everything
   including `wsl --update`). Fixed by: pointing Playwright at the real installed Chrome
   (`channel: 'chrome'` in `lib.js`) instead of downloading its own copy. Avoid re-introducing a
   dependency on Playwright's bundled browser.
2. **GembaDocs anti-debug trap**: opening DevTools mid-load pauses on a `debugger;` statement.
   Not actually malicious — just an injected trap. Not relevant to the scripts (they don't use
   DevTools), noted here only in case someone debugs via DevTools again.
3. **GembaDocs internal API is fully encrypted** (both request query param and response body are
   opaque ciphertext blobs) — this is why we scrape the rendered page instead of calling their
   internal API directly. Their official public API (`publicapi.gembadocs.com`) exists but needs an
   API key we don't have access to under the current login's role.
4. **ToS note**: gembadocs.com's footer states "AI scraping, cloning, or training prohibited."
   Flagged to and acknowledged by the account owner before proceeding — not a blocker for an
   authorized account owner, but keep in mind if this script is reused elsewhere.
5. **Skeleton-loading races**: both the SOP list and each SOP's steps section render asynchronously
   after the page's main content — waiting on the wrong/too-early selector silently returns 0 or a
   wrong count (e.g. `.view__sop__img` alone matched 47 unrelated elements before we scoped it to
   `.load_step_records .view__sop__img` and waited for a real `.step-num` to appear first).
6. **Display order in our app**: the SOP list sorts by `updatedAt desc`, so push *order* determines
   display order (last pushed = top). `push-to-app.js` pushes oldest-on-gembadocs.com first using
   each JSON file's **mtime** (not `manifest.json`, which is stale mid-pull) — this is correct
   *within one push run*. Pushing in multiple separate batches is still safe for ordering as long as
   each batch is pulled from gembadocs.com in one continuous top-to-bottom sweep (which `pull-all.js`
   always does) — newer batches of *newly-pulled* SOPs are always further down gembadocs.com's list
   than everything already pushed, so later pushes correctly land below earlier ones.
7. **Our app's own rate limit (120 req/min global throttle)**: pushing ~50 SOPs back-to-back with no
   pacing tripped `ThrottlerException` (429) mid-upload for over half of them, leaving them created
   but with 0 steps (the SOP record was made, then the steps PUT never ran). Fixed by: pacing every
   request ~350ms apart and retrying on 429 with backoff (see `throttledFetch` in `push-to-app.js`),
   plus auto-deleting any partially-created SOP if a later step fails so reruns retry it cleanly
   instead of being skipped as "already exists". **This is why pushing is now done in phases/batches
   — smaller batches are easier to verify and cheaper to retry if something goes wrong.**

## Verifying a batch

After each push batch, spot-check for empty (0-step) SOPs — don't assume "created" means "complete":

```js
// quick inline check, run from scripts/gemba-import/
node -e "
require('dotenv').config();
(async () => {
  const r = await fetch('http://localhost:3000/api/auth/login', {method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({email: process.env.APP_EMAIL, password: process.env.APP_PASSWORD})});
  const { accessToken } = await r.json();
  const l = await fetch('http://localhost:3000/api/sops?limit=200', {headers:{Authorization:'Bearer '+accessToken}});
  const list = await l.json();
  console.log('total:', list.total);
})();
"
```

For a full 0-step sweep (slower, checks every SOP's steps), see the inline script used in-session —
list all SOPs, then `GET /api/sops/:id/versions/:activeVersionId` for each and check `steps.length`.

## Credentials

Both gembadocs.com and the local app's login are in `.env` (gitignored, never commit). See
`.env.example` for the required keys.

## Kanbans (504) — added 2026-10-05

Pipeline (all resumable, all paced to stay under the app's 120 requests/minute limit and gentle on gembadocs.com):

1. `node pull-kanbans.js` — scrolls the Kanbans list (`/front-dashboard?tab=kanban`) to collect every card (created date, creator,
   last modified, colour, list position), opens each kanban's view page (`/view-kanban/<id>`) for all fields, downloads the picture.
   Output: `output/kanbans/<id>.json`, `output/kanbans/images/`, `output/kanbans/manifest.json` (list order). Skips kanbans already on disk.
   `--limit=N` for a test; do **not** use `--url=` to retry one (it has no list-card data) — re-run the plain command instead.
2. `node push-kanbans.js` — uploads each picture and creates the kanban through the API; remembers progress in `output/kanbans/.pushed.json`.
3. `node apply-kanban-fidelity.js` — sets Created Date, Last Modified and Created By (not settable via the API) with a one-off script run in the api container;
   same-day kanbans keep gembadocs' list order (the one higher up gets the later creation time).
4. `node verify-kanbans.js` — compares count, list order, every text field, creator, dates and each picture (sha256) with what was pulled. Exit code 1 on any mismatch.

Result: 504/504 imported, **0 mismatches** (order differs at 0 of 504 positions).

Things that are as gembadocs has them, not import bugs: 8 pictures are completely white; 3 part numbers are mistyped at the source
(`[1SH94-039`, `1SH71-012]`, `0.031251SH09-022`); gembadocs cuts descriptions at 50 characters; one "Ordering Item URL" is plain text, not a web link, so the app's
link-only field was left empty. Values the app has no field for yet (Language, Show Barcode in Bin Label, PDF header text colour, second ordering URL) stay in the JSON — see Task K1 in `TASK_TRACKER.md`.
