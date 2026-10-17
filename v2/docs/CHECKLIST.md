# Dolphin Tracker v2 — Checklist

Tracks delivery against [PLAN.md](./PLAN.md). Tick items as they land; add sub-items when the detailed plan splits them.

**Phase 0 — Foundations**
- [x] Plan approved; `v2/docs/PLAN.md` and `v2/docs/CHECKLIST.md` written
- [x] `v2/` layout created: `infra/`, `backend/`, `frontend/`, `docs/`
- [x] Local dev: DynamoDB Local in docker-compose, backend run script, Vite dev server
- [x] CI skeleton: lint + tests for backend and frontend, `cdk synth` on PR
- [x] Detailed plan written as `AGENT-HANDOFF.md`: table keys, repository interfaces, endpoint list with pagination, field schema shape, store-view behaviour

**Phase 1 — Infra skeleton**
- [x] `DataStack`: table + GSI1, point-in-time recovery on
- [x] `ApiStack`: api Lambda, worker Lambda, HTTP API with CORS, SSM parameters, upload and results bucket
- [x] `WebStack`: S3 site + CloudFront; `/api/*` behavior to the HTTP API
- [ ] `dev` deployed; health endpoint and placeholder page reachable through CloudFront

**Phase 2 — Backend port**
- [x] Router / service / repository layers scaffolded with dependency injection and fakes
- [x] Decimal/float serializer and cursor pagination helpers
- [x] Projects: list (paginated), get, create (routing as job), patch, delete
- [x] Stores: list (paginated, filter, search), get, update details with geocode verify, progress update, map pins endpoint
- [x] Installers: add, rename; routing: reassign (sync), rebalance, recluster (jobs)
- [x] Jobs: create import, poll status, results from S3; worker handler for import and routing
- [x] Pandas removed; CSV via `csv`, Excel via `openpyxl`; parser tests updated
- [x] Optimizer ported unchanged behind `RoutingService`; `stops_per_day` per project
- [x] Field schema stored on project; import maps columns to schema
- [x] Migration script Mongo → DynamoDB with parity report
- [x] Contract tests cover every endpoint
- Tasks (AGENT-HANDOFF §5):
  - [x] B1 field schema + validation
  - [x] B2 store repository
  - [x] B3 job repository + worker invoker
  - [x] B4 local file store + local upload route
  - [x] B5 import job end to end
  - [x] B6 project create + routing job + routes bundle
  - [x] B7 store endpoints
  - [x] B8 installers + routing operations
  - [x] B9 append stops, delete, patch
  - [x] B10 project list KPI
  - [x] B11 places + config endpoints
  - [x] B12 migration script
  - [ ] B13 Lambda smoke in dev

**Phase 3 — Frontend core + Stores**
- [x] Vite + React 19 + TS + Tailwind v4 scaffold (shadcn/ui config ready, components added as needed)
- [x] Typed API client generated from OpenAPI
- [x] TanStack Query setup, Zustand UI store, auth provider no-op
- [x] Dashboard page (KPIs, charts, project cards, filters)
- [x] Import wizard: presigned upload, live job progress, review table, column-to-field mapping
- [x] Project shell with Stores / Routes / Settings tabs and `routing_status` banner
- [x] Stores tab: virtualized editable table, required name + address, drawer editor, CSV export
- [x] Shared `MapView`: status pins, same-address stacking, legend toggles, clustering, table sync
- [x] Settings tab: metadata, installers, `stops_per_day`, field schema editor
- Tasks (AGENT-HANDOFF §5):
  - [x] F1 typed API client
  - [x] F2 shadcn/ui primitives
  - [x] F3 dashboard
  - [x] F4 import wizard + append flow
  - [x] F5 project shell + settings
  - [x] F6 MapView
  - [x] F7 stores tab

**Phase 4 — Routes port**
- [x] Installer tabs with stats; day cards with ordered stops and status counts
- [x] Stop editing parity with the legacy page (progress, additional task, comment, installer name)
- [x] Reassign with confirmation; rebalance and recluster as jobs with progress
- [x] Google Maps route links, copy addresses, per-day and full CSV export
- [x] Legacy planner page and iframe removed (nothing in v2 references it; the v1 file itself goes at cutover)
- Tasks (AGENT-HANDOFF §5):
  - [x] R1 routes tab port
  - [x] R2 remove the iframe path

**Phase 5 — Cutover**
- [ ] Prod stacks deployed; Google keys restricted by referrer and API
- [ ] Prod data migrated; parity report reviewed
- [ ] Domain pointed at CloudFront; Vercel frozen; Mongo decommissioned after a holding period
- [ ] Legacy Atlanta project ported read-only or removed

**Phase 6 — Auth**
- [ ] Cognito user pool, hosted UI, groups for admin / planner / installer
- [ ] JWT authorizer on the HTTP API; role checks in services
- [ ] Frontend sign-in flow and token refresh; per-project visibility if required

---

## Round 2 (see AGENT-HANDOFF.md §9–§11, STORE-MODEL.md)

**Decisions applied (§9)**
- [ ] Browser Maps key and Map ID via infra config; S3/API CORS never `*`; prod synth fails on empty origins
- [ ] `LambdaInvoker` moved out of `services/`
- [ ] Places call skipped when geocoding fails; import start fails fast without a key outside local
- [ ] Schema field removal asks for confirmation when values exist
- [ ] CI drift check for the generated API client
- [ ] Dashboard charts lazy-loaded

**Review fixes (§10)**
- [ ] X1 Map fits bounds only when locations change
- [ ] X2 Stores tab refreshes when a routing build finishes
- [ ] X3 Day-card status select optimistic
- [ ] X4 Append retry does not resend a stale version
- [ ] X5 Import wizard shows result/schema fetch errors
- [ ] X6 Dashboard refreshes after append
- [ ] X7 Map hover restyle diffing; bounds published only when needed
- [ ] X8 Minor frontend fixes + tests
- [ ] X9 v1 fidelity gaps (after user confirms which)
- [x] Y1 Job runners idempotent on redelivery
- [ ] Y2 Wrong-shape cursor → 400
- [ ] Y3 Unlisted-installer stops visible in /routes; reassign 404 not 500; migration derives installers
- [ ] Y4 DT_AWS_REGION wired for Lambda
- [ ] Y5 add_installer appends atomically
- [ ] Y6 append holds the routing slot
- [ ] Y7 rename installer_name writes threaded
- [ ] Y8 cp1252 replace; empty CSV header → column_N
- [ ] Y9 migration day/datetime normalisation
- [ ] Y10 invoker and cursor helpers out of services/dynamo coupling

**Phase 5 — Store model v2 (§11)**
- [ ] S1 Domain model v2: screens, statuses, derived status, validation
- [ ] S2 Import mapping v2 from the IBC sheet, screen rows, dedupe by external_id then address
- [ ] S3 Repository: external_id uniqueness markers, screens write, address dedupe
- [ ] S4 Store API v2: fields, screens, filters, by-state, export, KPI v2, client regenerated
- [ ] S5 Routing pending set on derived status
- [ ] S6 Migration v2 status mapping and parity
- [ ] S7 Store drawer and table v2
- [ ] S8 Filters with greyed empties, top-states chart, KPIs
- [ ] S9 Import wizard v2: mapping override, duplicates, screens preview
- [ ] S10 Routes tab follow-through
