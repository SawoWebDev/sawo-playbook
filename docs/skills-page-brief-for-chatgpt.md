# Brief for review: the "Skills" page of SAWO Playbook

Please read this and (1) tell me whether you understand what the page is for, (2) review it critically, and (3) suggest concrete
improvements, ranked by value vs effort. Everything below describes what exists **today**; I have not invented features.
If something is unclear or you would need a screenshot, tell me instead of guessing.

---

## 1. The product in one paragraph
SAWO Playbook is an internal web app for a manufacturing company. It stores **SOPs** (standard operating procedures: step-by-step work
instructions with photos, shown in the app as "STD OPS") and **Kanban cards** (printable part/bin cards for re-ordering parts). Staff open
an SOP on the shop floor, follow the steps, and supervisors keep SOPs up to date. The app has three user roles: **Admin**, **Editor** and
**Viewer**. The top menu is: Folders, STD OPS, Kanbans, Skills.

## 2. What the Skills page is for
It answers one question: **"Who is trained on which procedure, and is that training still current?"**

It is a **skills (training) matrix**: a grid with one row per person (associate) and one column per published SOP. Each cell shows how
well that person has been assessed on that SOP, using a small pie-style icon. A trainer/supervisor clicks a cell to record a new
assessment. Every assessment is kept as history, and the matrix always shows the latest one.

## 3. The five competency levels
| Level | Name | Icon |
|---|---|---|
| 0 | No Training | empty circle |
| 1 | Knows Basic Principles | quarter filled |
| 2 | Demonstrates Basic Principles | half filled |
| 3 | Able to Work Alone | three quarters filled |
| 4 | Able to Train Others | full circle, green (the others are brand brown) |

## 4. What is on the page, top to bottom
1. **Legend** - the five icons with their level number and name.
2. **Four summary tiles (KPIs):** number of Associates; number of Published SOPs tracked; number of cells at the top level (4); number of cells
   that **Need reassessment** (highlighted warning colour when above 0).
3. **The matrix table:**
   - Left column (stays visible while scrolling sideways): the person's avatar, name and role.
   - One column per published SOP: header shows the SOP **reference number** and its **name**; hovering shows the name and current version.
   - Each cell is a button with the level icon. Hover text: "Level 3 on v2 · 12 Sep, 2026" or "Not assessed".
   - A small **dot** on a cell means "assessed against an older version of the SOP; a newer version has since been published; reassess".
   - A footer line explains the dot, and (for people who can edit) "Click a cell to record an assessment".
   - If no SOP is published: an empty-state message "Publish SOPs to track skills against them."
4. **Training history** - a table of the latest 100 assessments: when, associate, SOP (reference + version), level (icon + name), trainer, notes.
5. **"Assess <name>" dialog** (opens when you click a cell): shows the person and the SOP + version; five radio options (icon + number + name);
   an optional Notes box; Cancel / "Record assessment".

There is also a smaller version of the same idea inside the STD OPS list: each SOP card's ••• menu has **Update Training Record**
(pick an associate and a level for that one SOP) and **Training History** (assessments for that SOP).

## 5. Rules and behaviour (from the code)
- **Who can see what.** Admin and Editor can see everyone and can record assessments. A Viewer can see only **their own row**, and cannot assess.
- **You cannot assess yourself** (the server refuses, and your own cell is disabled).
- **Only active people** appear as associates. Only SOPs that are **published, not archived, not deleted** appear as columns.
- **An assessment is tied to the exact published version** of the SOP that was current at that time. If the SOP is later published again as
  a new version, the old assessment stays valid as history, but the cell gets the "reassess" dot. This is automatic: *any* new published
  version flags *every* person assessed on the older one.
- **Assessments are append-only history.** Each new assessment adds a row; a second table holds only the *current* level per person+SOP
  (and can be rebuilt from history by an admin-only repair endpoint).
- Recording an assessment saves the history row, updates the current level and writes an **audit log** entry in one transaction (all or nothing).
- The date of an assessment is always "now" (it cannot be back-dated). Notes are optional text (max 4000 characters).
- The server also supports: filtering the matrix by SOP folder or by role; filtering history by person or SOP; and assigning "trainers" to
  associates. **The page does not use any of these**, and the trainer assignment feature has no screen (the code calls the old trainer
  concept "retired").
- Levels are fixed (0-4, the five names above). They cannot be renamed or changed per company.

## 6. Technical shape (only if useful)
Next.js (React) page, NestJS API, PostgreSQL. API: `GET /skills/matrix`, `GET /skills/history`, `POST /skills/assessments`,
`POST /skills/rebuild`, trainer assignment routes. Data: `skill_assessment` (history) and `skill_record` (current state, one row per
person+SOP). The page loads the **whole** matrix and history in two requests, with no paging.

## 7. The current data (honest snapshot of my install)
- 2 active associates (both Admin), **103 published SOPs**, so the matrix is 2 rows x 103 columns.
- **0 assessments recorded**, so every cell is empty and the history table is empty. I have not yet seen the page with realistic data
  (for example 40 people x 100 SOPs).
- Many original SOP authors exist only as inactive "imported" users, so they do not appear in the matrix.

## 8. Problems and gaps I already suspect (please confirm, add to, or push back)
1. **"Not assessed" and "Level 0 - No Training" look identical** (both an empty circle). Is that confusing? Should "never assessed" look different?
2. **Width:** 100+ SOP columns means a very wide table and lots of horizontal scrolling. No search, no filter, no sort, no grouping by
   folder/area, no frozen header row. The server can filter by folder and role, but the page does not offer it.
3. **One cell at a time.** To train 10 people on one SOP, or one person on 20 SOPs, I must open the dialog 10 or 20 times. No bulk assess.
4. **"Reassess" is blunt.** Any new published version, even fixing a typo, marks everyone as outdated. There is no "minor change, no
   retraining needed" option, no due date, and no expiry or re-certification cycle (for example "refresh yearly").
5. **No targets or gap analysis.** There is no way to say "this role/person must reach level 3 on these SOPs", so the matrix cannot show who is
   below the required level.
6. **No export or print** (CSV/PDF), which auditors and supervisors usually want.
7. **History** shows only the latest 100 with no filters or paging on the page, and the person's name in a row does not link anywhere. Cells do not
   link to the SOP.
8. **Back-dating and evidence:** the assessment date is always now; there is no way to record "trained last Tuesday", attach a signature or a
   sign-off, or note which trainer did it beyond the logged-in user.
9. **Self-assessment block** means a company with one admin can never record anything for themselves; and with only two admins, only one cell
   row is editable.
10. **Accessibility:** meaning relies on small icons and a colour-coded dot; each icon has only a short text label.
11. **No groups/teams** or shifts to view or filter by; the role (Admin/Editor/Viewer) is shown under the name, which is a permission level, not a job role.
12. **Duplication:** the same recording exists in the STD OPS card menu and on this page, with slightly different features.
13. **No notifications:** nobody is told when training becomes outdated or when they are assessed.
14. Level names are fixed and not translatable.

## 9. What I would like from you
A. **Explain back to me in your own words** what this page does, who it is for and what decisions it supports (so I know the description is clear).
B. **Review it as a product/UX expert** for a small-to-mid factory: what is missing, confusing or risky, compared with good practice for
   skills/training matrices (for example ISO 9001 competence records, "ILUO" style matrices, typical Lean/TWI training matrices).
C. **Give a ranked improvement list** (quick wins, medium, large), each with: the problem it solves, a one-sentence description of the change,
   and rough effort (S/M/L). Please keep the quick wins realistic for one developer using the existing stack.
D. **Propose a better layout** for hundreds of SOPs x many people (for example grouping by folder, a per-person view, a per-SOP view, a
   "who needs training" list) and say which one you would build first.
E. **Check the rules** in section 5: are any of them wrong, unsafe or surprising? (for example the self-assessment ban, the all-or-nothing outdated flag,
   the fixed levels.)
F. **Suggest 5 questions** I should ask the supervisors who will actually use this page before I change anything.
G. Tell me clearly which parts of your advice depend on assumptions you had to make.
