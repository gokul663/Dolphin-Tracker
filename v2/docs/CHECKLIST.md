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
- [ ] Projects: list (paginated), get, create (routing as job), patch, delete
- [ ] Stores: list (paginated, filter, search), get, update details with geocode verify, progress update, map pins endpoint
- [ ] Installers: add, rename; routing: reassign (sync), rebalance, recluster (jobs)
- [ ] Jobs: create import, poll status, results from S3; worker handler for import and routing
- [x] Pandas removed; CSV via `csv`, Excel via `openpyxl`; parser tests updated
- [ ] Optimizer ported unchanged behind `RoutingService`; `stops_per_day` per project
- [ ] Field schema stored on project; import maps columns to schema
- [ ] Migration script Mongo → DynamoDB with parity report
- [ ] Contract tests cover every endpoint
- Tasks (AGENT-HANDOFF §5):
  - [x] B1 field schema + validation
  - [x] B2 store repository
  - [x] B3 job repository + worker invoker
  - [x] B4 local file store + local upload route
  - [x] B5 import job end to end
  - [ ] B6 project create + routing job + routes bundle
  - [ ] B7 store endpoints
  - [ ] B8 installers + routing operations
  - [ ] B9 append stops, delete, patch
  - [ ] B10 project list KPI
  - [x] B11 places + config endpoints
  - [ ] B12 migration script
  - [ ] B13 Lambda smoke in dev

**Phase 3 — Frontend core + Stores**
- [x] Vite + React 19 + TS + Tailwind v4 scaffold (shadcn/ui config ready, components added as needed)
- [ ] Typed API client generated from OpenAPI
- [x] TanStack Query setup, Zustand UI store, auth provider no-op
- [ ] Dashboard page (KPIs, charts, project cards, filters)
- [ ] Import wizard: presigned upload, live job progress, review table, column-to-field mapping
- [ ] Project shell with Stores / Routes / Settings tabs and `routing_status` banner
- [ ] Stores tab: virtualized editable table, required name + address, drawer editor, CSV export
- [ ] Shared `MapView`: status pins, same-address stacking, legend toggles, clustering, table sync
- [ ] Settings tab: metadata, installers, `stops_per_day`, field schema editor
- Tasks (AGENT-HANDOFF §5):
  - [ ] F1 typed API client
  - [ ] F2 shadcn/ui primitives
  - [ ] F3 dashboard
  - [ ] F4 import wizard + append flow
  - [ ] F5 project shell + settings
  - [ ] F6 MapView
  - [ ] F7 stores tab

**Phase 4 — Routes port**
- [ ] Installer tabs with stats; day cards with ordered stops and status counts
- [ ] Stop editing parity with the legacy page (progress, additional task, comment, installer name)
- [ ] Reassign with confirmation; rebalance and recluster as jobs with progress
- [ ] Google Maps route links, copy addresses, per-day and full CSV export
- [ ] Legacy planner page and iframe removed
- Tasks (AGENT-HANDOFF §5):
  - [ ] R1 routes tab port
  - [ ] R2 remove the iframe path

**Phase 5 — Cutover**
- [ ] Prod stacks deployed; Google keys restricted by referrer and API
- [ ] Prod data migrated; parity report reviewed
- [ ] Domain pointed at CloudFront; Vercel frozen; Mongo decommissioned after a holding period
- [ ] Legacy Atlanta project ported read-only or removed

**Phase 6 — Auth**
- [ ] Cognito user pool, hosted UI, groups for admin / planner / installer
- [ ] JWT authorizer on the HTTP API; role checks in services
- [ ] Frontend sign-in flow and token refresh; per-project visibility if required
