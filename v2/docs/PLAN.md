# Dolphin Tracker v2 — AWS re-architecture + store-level view (high-level plan)

## Context

Dolphin Tracker today is a FastAPI + MongoDB backend deployed as one Vercel Python function, with a Create React App dashboard and a legacy vanilla-JS route planner page loaded in an iframe. It imports site lists from spreadsheets, verifies addresses with Google, splits sites into installer territories and ≤8-stop days, and tracks per-stop field progress.

Goals for v2:
1. Host entirely in AWS: Lambda + API Gateway backend, static React frontend, Cognito login later.
2. Modern frontend: React 19, Vite, TypeScript, Tailwind, Zustand (+ TanStack Query for server state).
3. Add a **store-level view** per project: a flat list of stores (not grouped by installer/day) with editable imported fields, store name and address mandatory, plus a synced map.
4. No loss of current capability. Decide DynamoDB vs MongoDB on merit.

Decisions already made by the user: Stores and Routes are side-by-side tabs over the same records; the store view is built directly in the new stack; CDK in Python; TypeScript frontend; thin router → service → repository layering; paginated list endpoints; the existing optimizer is kept unchanged for now; the per-day stop cap becomes configurable in the 20–50 range; all new code and docs live under `v2/`; the legacy Atlanta project is deferred.

**Vocabulary.** A *stop* is one store or site visit record inside a project. A project holds many stops across several installers and several days. The *per-day cap* (`STOPS_PER_DAY`, hardcoded to 8 in `backend/server.py` today) is the maximum stops one installer is given on one day. If the current dashboard shows zero sites, the deployed backend has no projects in its database or cannot reach it; that is a deployment state, not a code constant.

**Where the work lives.** Everything new goes under `v2/` in this repo so v1 keeps running untouched until cutover:

```
v2/
  docs/        PLAN.md (this document), CHECKLIST.md, later DETAILED-PLAN.md and ADRs
  infra/       CDK app in Python
  backend/     Lambda handlers, routers, services, repositories, domain, tests
  frontend/    Vite + React 19 + TypeScript
```

Status: high-level plan, approved 2026-10-16. The per-endpoint and per-task detail lives in `AGENT-HANDOFF.md`. Progress is tracked in `CHECKLIST.md`.

---

## Part 1 — Database: why Mongo today, and should it be DynamoDB

**Why MongoDB now.** The app was scaffolded by a prototype generator (the craco config still references `@emergentbase/visual-edits`). Mongo was the default: one document per project with an embedded `stops` array, plus a key-value collection for stop progress. The code uses only `find_one` by id, `find` by `project_id`, `update_one`, and `insert_many`. No aggregation pipeline, no text search, no multi-field queries. All computation happens in Python.

**DynamoDB fit.** Every access pattern is "whole project by id" or "list projects". One partition key plus one sparse index covers everything. DynamoDB is also the better operational match for Lambda: IAM auth instead of connection strings, no connection pooling, no VPC, no cold-start handshake.

**Cost at this scale** (≤20 projects, ≤1000 stops each, low thousands of requests/day):

| Option | Monthly | Notes |
|--------|---------|-------|
| DynamoDB on-demand + Lambda + HTTP API + S3 + CloudWatch | **$2–8** | Storage ~20 MB; most of it inside free tier |
| MongoDB Atlas on AWS | $30–90 | Flex or M10 tier, plus PrivateLink or NAT if not publicly exposed; Lambda connection-reuse tax |
| Amazon DocumentDB | $90–120 floor | VPC-only, so Lambda in VPC + NAT Gateway to reach Google; not fully Mongo-compatible |

**What changes or is lost (honest list).**

| # | Item | Severity | Mitigation |
|---|------|----------|------------|
| 1 | 400 KB item limit. The seed project is 623 stops at ~320 B each with 13 fields; with the full 21-field stop plus progress it is ~360 KB, and 1000 stops ≈ 700 KB. Embedding stops in the project item is not viable. | Low (an improvement) | One item per stop. Single-stop edits stop rewriting the whole project. |
| 2 | Bulk route rewrites (rebalance, recluster, add installer) are one atomic `update_one` today. In DynamoDB they become N `UpdateItem`s; a reader can see a half-applied layout for ~1–2 s; transactions cap at 100 items. Note today's project write and the follow-up state-key rewrites are already non-transactional, so the gap is narrower than it looks. | Medium | Diff old vs new `(installer, day, seq)` and update only changed stops, fenced by an optimistic `version` on the project item checked first. Recompute is idempotent, so a retry heals a partial write. Fallback if strict atomicity is ever required: store stops as ≤350 KB ordered chunks and transact over ≤3 chunks. |
| 3 | Project-list KPIs today scan every state doc. | Low | v1: one projected Query per project in parallel and reuse the existing `kpi_summary` logic (~1,750 read units per list load ≈ $0.0002). v2 when needed: write a KPI snapshot onto the project item from a DynamoDB Streams consumer. Incremental counters are rejected because the unique-address completion metric cannot be maintained incrementally without drift. |
| 4 | Ad-hoc reporting later (by PA, by DMA across projects, completion over time). | Low now, medium later | Dataset is tiny; a scan into pandas or DuckDB works ad hoc. For a product feature: export to S3 + Athena, or Streams → Firehose. |
| 5 | No server-side uniqueness on venue code or address. | Low | Dedupe already lives in Python (`duplicate_key` in `backend/server.py`). A marker item with `attribute_not_exists` can enforce it if wanted. |
| 6 | boto3 rejects Python floats and returns `Decimal`; every lat/lng crosses that boundary. | Low, guaranteed to bite once | One `to_ddb` / `from_ddb` serializer in the repository layer. Optimizer stays float-only. |
| 7 | 1 MB Query page; projects above ~1200 stops need pagination loops. | Low | boto3 paginator. |
| 8 | Local development moves from `mongod` to DynamoDB Local or `moto`. | Low–medium friction | `moto` for tests, DynamoDB Local in docker-compose for manual dev. |
| 9 | The legacy `atlanta-default` project reads a shared `stop_states` collection also used by another app. | Deferred | Not on the critical path. Port it as a read-only project or remove it after cutover. The new design does not carry the "external project" special case. |

Not actually lost: `$setOnInsert` (→ `if_not_exists()`), nested partial updates, cross-collection transactions (never used today), and the 16 MB document cap is irrelevant with per-item storage.

**Recommendation: DynamoDB.** Nothing the app does today is lost. The two real design costs (bulk rewrite fencing, KPI aggregation) are solved once in the repository layer.

---

## Part 2 — Target AWS architecture

```
Browser: React 19 + Vite + TS, Tailwind, shadcn/ui, Zustand, TanStack Query
   │
CloudFront
   ├── /            → S3 static site
   └── /api/*       → API Gateway HTTP API (Cognito JWT authorizer added in Phase 6)
                        └── Lambda "api"   Python 3.12, FastAPI + Mangum, no pandas
                              ├── DynamoDB single table
                              ├── SSM Parameter Store (Google server key)
                              ├── Google Geocoding / Places (single-address verify only)
                              └── async invoke → Lambda "worker"  plain handler, 15 min, 1769 MB
                                                  parse + geocode jobs (thread pool of 8–10),
                                                  heavy routing jobs; progress → DynamoDB,
                                                  results → S3; frontend polls GET /jobs/{id}
```

Both Lambdas deploy from one codebase with two handlers, so the optimizer, parser, and repository stay in one place.

**Why imports must become asynchronous.** API Gateway times out at ~29 s. Today `parse-file` geocodes every row synchronously with two Google calls each (0.3–0.8 s per row), so the wall is hit at roughly 40–70 rows. The new flow: browser gets a presigned S3 URL, uploads the file, the API enqueues a job, the worker parses and geocodes concurrently (1000 rows in ~1–2 min instead of ~10), writes progress to the job item, and the frontend polls. This replaces the fake progress timers in today's dialogs with real progress.

**Routing runs as a background job, not inside a request.** The optimizer is kept exactly as it is, isolated behind a `RoutingService` so the algorithm can be swapped later without touching routers or repositories. The per-day cap becomes a per-project setting (`stops_per_day`, set at creation, editable in Settings, range 1–50) instead of the hardcoded 8. What that does to runtime, measured locally on `build_project_routes` with 3 installers (Lambda is roughly 1.5–2.5× slower):

| Stops | Per-day cap | Local | vs 29 s API window |
|-------|-------------|-------|--------------------|
| 300 | 8 | 3.3 s | OK |
| 300 | 20 | 22.5 s | over on Lambda |
| 300 | 30 | 35.7 s | over |
| 300 | 50 | 58.9 s | over |
| 600 | 8 | 13.2 s | borderline |
| 600 | 20 | 63.8 s | over |
| 600 | 30 or 50 | > 90 s | far over |

Larger days make the within-day optimization (all-starts nearest neighbour, 2-opt, boundary swaps) dominate, so at the requested cap even a 300-stop project cannot finish inside an API Gateway request. Consequence: project creation, recluster, rebalance, and add-installer all run on the worker Lambda (15 min limit, 1769 MB for maximum single-thread CPU). The API writes the project with `routing_status=building`, returns 202 with a job id, and the UI polls until `ready`; stops remain viewable in the Stores tab during the build. Reassign-stop is instant and stays synchronous. Append-stops uses the existing greedy placement and stays synchronous. The optimizer's own test suite moves over unchanged and guards the port; algorithm improvements are a separate later decision.

**DynamoDB single table.**

| PK | SK | Holds |
|----|----|-------|
| `PROJECT#<id>` | `META` | name, pa, type, installers, percentages, field schema, `version` (optimistic lock), `routing_status`, `stop_count`, created/updated; `GSI1PK=PROJECT`, `GSI1SK=created_at` |
| `PROJECT#<id>` | `STOP#<stop_uid>` | planning: display `id` ("S12"), address, geo, installer, `day`, `seq` (order within day), imported field values. Progress on the same item: status, comment, additional_task, installer_name, store-name override, updatedAt/updatedBy |
| `JOB#<jobId>` | `META` | status, progress, counts, S3 result key, TTL 24 h |
| GSI1 | `GSI1PK` / `GSI1SK` | sparse index over META items only: list projects newest first |

Design notes that fall out of the current code:
- **Progress lives on the stop item, not a sibling item.** It is 1:1 with the stop, the UI already merges them, and routing rewrites touch only `installer`, `day`, `seq` through disjoint update expressions, so a tech's status write and a planner's rebalance never collide and nothing is ever re-keyed. This deletes the composite `atl-route-v2|installer|id|addr|lat|lng` key and the key-rewrite blocks in six endpoints, the most fragile code in the backend.
- **`stop_uid` is a server-minted uuid.** The display `id` is kept but not trusted as unique (the code already guards against duplicate ids in reassign).
- **`seq` is explicit.** Today route order is array position; per-item storage needs it stored.
- **Read paths stop writing.** `GET /projects/{id}` currently repairs addresses and writes on every read. That moves to the migration script.

**Backend layering.** Three thin layers, no more:

| Layer | Responsibility | Examples |
|-------|----------------|----------|
| Routers (FastAPI) | HTTP only: parse request, validate with Pydantic, call one service method, map errors to status codes. No business logic, no DynamoDB calls. | `routers/projects.py`, `routers/stores.py`, `routers/jobs.py` |
| Services | Use cases and rules: dedupe on append, routing fence and diff, progress updates, import orchestration, KPI assembly. Call domain functions and repositories. | `ProjectService`, `StoreService`, `RoutingService`, `ImportService` |
| Repositories | Persistence only: single-table key building, Decimal/float conversion, pagination cursors, batch and conditional writes. One per aggregate. | `ProjectRepository`, `StoreRepository`, `JobRepository`, `FileStore` (S3) |

Pure domain modules (`route_optimizer.py`, the pandas-free parser) sit beside these with no I/O. Dependency injection through FastAPI `Depends` so services take repositories as constructor arguments and tests pass fakes. Patterns stop there: no CQRS, no event sourcing, no ports-and-adapters ceremony. The worker Lambda calls the same services directly.

**API conventions.** Every list endpoint is paginated with an opaque cursor (the encoded DynamoDB `LastEvaluatedKey`) and a `limit` (default 50, max 200): project list, store list, job list, and the per-project progress log if one is added. Two endpoints return a bounded whole-project payload without pagination: the map pins endpoint (id, lat, lng, status, name only) and the routes bundle for the Routes tab, since both are bounded by project size and the UI needs all of it at once. Mutations return the affected record, not the whole project.

**Backend code reuse.** `backend/route_optimizer.py` moves over unchanged. `backend/server.py` is ported endpoint by endpoint onto a `ProjectRepository` (boto3); FastAPI via Mangum keeps the Pydantic models, validation, and OpenAPI docs. **Pandas is removed entirely**: it is imported only for `pd.isna` in `clean_cell` and for reading files, yet it drags ~100 MB and 1.5–3 s of cold start into every API call. `clean_cell` becomes a two-line null check, CSV reading uses the `csv` module already in use, and Excel reading uses `openpyxl` directly (~1 MB). Parser tests are updated to match.

Smaller fixes the port picks up: CORS today sets wildcard origins with credentials, which browsers reject; configure CORS on the HTTP API with explicit origins. The browser Maps key must be referrer-restricted in Google Cloud before it is served from an AWS URL. Mangum runs with lifespan off; table and index creation move to CDK.

**Infra as code: CDK in Python.** Stacks: `DataStack` (table + GSI), `ApiStack` (two Lambdas, HTTP API, SSM parameters, S3 upload bucket), `WebStack` (S3 site, CloudFront, optional custom domain), `AuthStack` later (Cognito). Environments `dev` and `prod`. GitHub Actions deploys through an OIDC role. Lambda Powertools for logging and tracing; CloudWatch alarms on 5xx and failed jobs.

**Repo layout:** everything under `v2/` as shown in Context: `v2/infra` (CDK), `v2/backend` (handlers, routers, services, repositories, domain, tests), `v2/frontend` (Vite). The v1 tree at the repo root (`backend/`, `frontend/`, `ara_tracker.py`, `atlanta_seed.json`, `vercel.json`, the legacy HTML page) stays untouched until cutover and is removed afterwards.

---

## Part 3 — Frontend stack

| Concern | Choice | Why |
|---------|--------|-----|
| Build / framework | Vite, React 19, TypeScript | As requested. |
| Styling / components | Tailwind v4, shadcn/ui (Radix) | The current dashboard already uses shadcn, so visual parity is cheap. |
| Server state | TanStack Query | Almost all app state is server data. Caching, optimistic updates, polling for jobs and `routing_status`. |
| UI state | Zustand | Filters, selected store, active tab, map viewport. Small and local. |
| Redux? | No | Nothing needs middleware, time-travel, or a global event log. Zustand + TanStack Query covers it. Revisit only if offline-first field editing becomes a requirement. |
| Map | `@vis.gl/react-google-maps` + marker clusterer | Google's React library. One shared `MapView` used by Stores and Routes. |
| Tables | TanStack Table + TanStack Virtual | Inline-editable store list that stays fast at 1000+ rows. |
| Forms / validation | react-hook-form + zod | Shared zod schemas for store fields and import mapping. |
| Routing | React Router 7 | Already in use. |
| Charts | Recharts | Already in use. |
| Auth slot | `AuthProvider` no-op now, Cognito later | API client attaches a bearer token when present. |

Pages: Dashboard (port of the existing React page, which uses only seven endpoints), Project shell with tabs **Stores** (new) / **Routes** (React rebuild of the legacy planner, which is the sole consumer of the state, reassign, rename, add-installer, rebalance, and stop-details endpoints) / **Settings** (installers, metadata, field schema), and the Import wizard (new async flow).

---

## Part 4 — Store-level view (new feature)

**Layout.** Inside a project, the Stores tab shows a table of every store and a map beside it, both driven by the same filters and search.

**Table.** Columns: store name (required), address (required), city/state/zip, status, installer, then the imported custom fields. Inline edit or a side drawer per store. Saving a changed address runs the existing geocode verification through the API and updates coordinates; the store is flagged "route may be stale" until the planner re-optimizes. Sort, filter by status/installer/any field, free-text search, CSV export of the current view.

**Map.** Same semantics as today's project status map: pins colored by status, same-address records stacked into one pin with a count, legend toggles per status, fit-to-bounds. New: clustering at low zoom, two-way sync with the table (hover row highlights pin, click pin selects row and opens its drawer), optional "only stores in view" filter. The exact differences from the route map are an open question below.

**Dynamic fields.** Each project carries a `field_schema`: a list of `{key, label, type, required, options, source_column}`. The import wizard maps spreadsheet columns to fields automatically by alias with manual override, and creates or extends the schema. Store name and address are fixed required fields; the current hardcoded venue type, DMA, venue code, and owner fields become default schema entries so existing data migrates cleanly. The user will supply the exact field list for the detailed plan.

**Relationship to Routes.** Same stop items. Status and progress edited in either tab show in both. Routing operations never touch imported field values.

---

## Part 5 — Phased delivery

| Phase | Outcome | Depends on |
|-------|---------|------------|
| 0. Foundations | This plan agreed. Monorepo layout, dev environment (DynamoDB Local, Vite), CI skeleton, repository interface and table design detailed. | — |
| 1. Infra skeleton | CDK deploys `dev`: empty API, static site, table, SSM params, upload bucket. Hello-world end to end. | 0 |
| 2. Backend port | Router/service/repository layers; all endpoints on DynamoDB with `stop_uid` and `seq`; cursor pagination; pandas removed; optimizer unchanged behind `RoutingService` with configurable per-day cap; async job pipeline for imports and all routing builds; existing optimizer/parser tests green plus service and repository tests; migration script run against a Mongo dump with parity checks. | 1 |
| 3. Frontend core + Stores | Dashboard, project shell, import wizard with real progress, Stores tab with table + map + editing + dynamic fields. | 2 |
| 4. Routes port | Legacy planner rebuilt in React: installer tabs, day cards, stop editing, reassign/rebalance/recluster, Google Maps links, CSV export. | 3 |
| 5. Cutover | Migrate prod data, point domain at CloudFront, freeze Vercel, decommission Mongo. | 4 |
| 6. Auth | Cognito user pool, hosted UI, JWT authorizer on the API, roles (admin / planner / installer), per-project visibility if needed. | 5 |

Phases 3 and 4 can overlap once the API is stable. The store view lands before the routes port so the new capability is visible early.

---

## Open questions for the detailed plan

1. Exact list of imported store fields and which are editable, required, or select-type.
2. The "some differences" between the store map and the route map.
3. Who edits in the field: are installers on phones? This sets the mobile layout priority for both tabs.
4. Custom domain and certificate for CloudFront.
5. Google Maps API budget: the import pipeline geocodes every row; a cache of previously verified addresses can cut repeat cost.

Deferred, not blocking: the legacy `atlanta-default` project is ported read-only or removed after cutover.

---

## Verification (how we will know each phase works)

- **Backend:** existing `tests/test_route_optimizer.py` and `tests/test_file_parser.py` stay green (parser tests updated for the pandas-free reader); service tests with fake repositories; repository tests against DynamoDB Local or `moto`; endpoint contract tests with FastAPI's TestClient including pagination cursors; a seeded import job and a 600-stop routing job at a 30-stop cap both complete on the worker in `dev` and flip `routing_status` to `ready`.
- **Infra:** `cdk synth` and `cdk diff` in CI on every PR; `dev` deploy on merge.
- **Frontend:** Vitest + Testing Library for store editing validation and import column mapping; Playwright smoke test: upload → review → create → Stores tab → edit a store → pin updates → Routes tab shows the same status.
- **Migration:** run on a Mongo dump copy; compare project, stop, and progress counts and per-project KPI totals between old and new APIs before cutover; log orphaned progress records that match no stop.

---
