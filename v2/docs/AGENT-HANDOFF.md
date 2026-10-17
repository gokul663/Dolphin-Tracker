# Dolphin Tracker v2 — Agent Handoff (Phases 2–4)

This file is the work order for implementation agents. It is self-contained: read it, then `PLAN.md` for
the reasoning behind decisions, and `CHECKLIST.md` for phase-level progress. Every task below has acceptance
criteria; the reviewer checks against them and the rules in §2.

Branch: work on feature branches off `tech-stack-migration`, one task per branch, PR back into
`tech-stack-migration`. Never modify the v1 tree at the repo root (`backend/`, `frontend/`, `ara_tracker.py`,
`vercel.json`, `tests/`). Everything lives under `v2/`.

---

## 1. What already exists (verified working)

```
v2/
  Makefile              make help | setup | ddb-up (docker or podman) | ddb-moto | ddb-table | backend-dev |
                        backend-test | backend-lint | frontend-dev | frontend-typecheck | frontend-test |
                        build-lambda | infra-synth | infra-deploy
  docker-compose.yml    DynamoDB Local :8000, admin UI :8001
  infra/                CDK (Python): DataStack (table + GSI1), ApiStack (api + worker Lambdas, HTTP API,
                        files bucket, SSM key), WebStack (S3 + CloudFront, /api/* → HTTP API). `cdk synth` passes.
  backend/
    src/dolphin_tracker/
      config.py                 Settings (env prefix DT_), resolve_google_server_key()
      domain/models.py          Project, Stop, Job, FieldDef, Page[T], enums
      domain/route_optimizer.py v1 optimizer, byte-identical, DO NOT EDIT
      domain/parsing.py         pandas-free CSV/XLSX reader, aliases, normalize_*; read_table(filename, raw)
      domain/addresses.py       parse_us_formatted_address, apply_parsed_address, duplicate_key
      domain/errors.py          NotFoundError (→404), ConflictError (→409)
      repositories/dynamo.py    Keys, to_ddb/from_ddb, encode_cursor/decode_cursor, TABLE_DEFINITION
      repositories/projects.py  ProjectRepository protocol + DynamoProjectRepository (DONE, reference impl)
      repositories/stores.py    StoreRepository protocol, Dynamo impl is a STUB
      repositories/jobs.py      JobRepository protocol, Dynamo impl is a STUB
      repositories/files.py     FileStore (S3 presign/get/put_json)
      repositories/memory.py    InMemoryProjectRepository (fake for tests)
      services/projects.py      list/get/update/delete done; create is a STUB
      services/stores.py        list/pins done (depend on stub repo); update_* are STUBS
      services/routing.py       build_assignments + diff DONE (pure); run_build STUB
      services/imports.py       parse() DONE; run() STUB
      services/geocoding.py     GoogleGeocoder (geocode, autocomplete, find_place) — ported from v1
      api/app.py, api/deps.py   FastAPI factory, DI providers, error mapping (NotImplementedError → 501)
      api/routers/              health (done), projects (list/get done), stores (empty), jobs (empty)
      handlers/api.py           Mangum entry point
      handlers/worker.py        job dispatcher: {"job_id", "job_type": "import_parse"|"routing_build", ...}
    tests/                      49 passing: optimizer, parsing, addresses, dynamo helpers, project repo (moto),
                                API (TestClient + fakes), routing service, import parse
    scripts/                    build_lambda.sh, create_local_table.py
  frontend/                     Vite 7 + React 19 + TS + Tailwind v4 + shadcn config, React Router 7,
                                TanStack Query, Zustand. Routes: / (dashboard), /projects/:id/{stores,routes,settings}
                                as placeholders. lib/api/client.ts (fetch wrapper), lib/auth (no-op), stores/ui.ts
```

Run everything: `cd v2 && make setup && make ddb-up && make ddb-table && make backend-dev` and, in another
terminal, `make frontend-dev`. Before marking any task done: `make backend-lint backend-test frontend-typecheck
frontend-test`.

---

## 2. Rules (the reviewer enforces these)

1. **Layering.** Routers: parse/validate/call one service/map errors, nothing else. Services: rules and
   orchestration, no boto3. Repositories: persistence only, no business rules. Domain: pure, no I/O.
2. **Do not edit `domain/route_optimizer.py`.** Adapt around it in `services/routing.py`.
3. **No pandas, no numpy** anywhere in the backend.
4. **Every list endpoint is paginated** (`limit` 1–200 default 50, opaque `cursor`, response `Page[T]`).
   Exceptions, deliberately whole-project: `GET …/stores/pins` and `GET …/routes`.
5. **Progress fields vs routing fields never share a write.** Routing writes touch only `installer`, `day`,
   `seq` (plus `updated_at`). Progress writes touch only `status`, `comment`, `additional_task`,
   `installer_name`, `updated_by` (plus `updated_at`). Detail edits touch core/schema fields and geo.
6. **Anything that can exceed a few seconds runs on the worker as a job** (imports, routing builds).
   Synchronous endpoints must stay well under the 29 s API Gateway limit at 1000 stops.
7. **Errors:** 404 `NotFoundError`, 409 `ConflictError`, 422 validation (`HTTPException(422, detail=...)`,
   detail may be a dict with `message` and `suggestions`), 400 bad cursor/params, 501 not implemented.
8. **Tests are part of the task.** Services: unit tests with in-memory fakes. Repositories: moto
   (`@mock_aws`) using `TABLE_DEFINITION`. Routers: `TestClient` with `dependency_overrides`. Frontend:
   Vitest + Testing Library for logic-bearing components. Keep existing tests green.
9. **Dependencies:** adding one is fine if justified in the PR description. Lambda runtime deps also go in
   `backend/requirements-lambda.txt`. Frontend deps pinned with caret ranges.
10. **TypeScript strict, no `any`.** API types come from the OpenAPI-generated client (task F1); do not hand-write
    duplicates.
11. **Secrets never in code.** Google server key via `resolve_google_server_key()`; browser key via settings.
12. **Logging** via `aws_lambda_powertools.Logger` in handlers/services; no `print` in library code.
13. **Update `CHECKLIST.md`** when a task lands. Put a short "How I verified" section in every PR.

---

## 3. Data contracts

### 3.1 DynamoDB items (table `dolphin-tracker-<env>`, PK/SK strings, GSI1 on GSI1PK/GSI1SK, TTL attr `ttl`)

| Item | PK | SK | Attributes |
|------|----|----|------------|
| Project | `PROJECT#<id>` | `META` | `entity=PROJECT`, `GSI1PK=PROJECT`, `GSI1SK=<created_at>`, all `Project` fields, plus `routing_job_id` (str, empty when idle) |
| Stop | `PROJECT#<id>` | `STOP#<uid>` | `entity=STOP`, all `Stop` fields, plus `route_stale` (bool, set when address/geo changed after routing) |
| Job | `JOB#<id>` | `META` | `entity=JOB`, all `Job` fields, `payload` (map, job-specific), `ttl` (epoch seconds, created + 24 h) |

Serialization: always through `to_ddb` / `from_ddb`; `Decimal` never leaks past a repository.

**Stop fields, core vs schema.** Core (top-level attributes): `uid`, `display_id`, `store_name`, `addr`, `city`,
`state`, `zip`, `lat`, `lng`, `geocoded`, routing (`installer`, `day`, `seq`), progress (`status`, `comment`,
`additional_task`, `installer_name`, `updated_by`), `route_stale`, `updated_at`. Everything imported from the
spreadsheet that is not core goes under `fields: {key: value}` keyed by the project's `field_schema` keys.

**Default field schema** (`domain/schema.py`, task B1). Used when a project is created without an explicit schema.
The user will supply the real list later; until then:

| key | label | type | required |
|-----|-------|------|----------|
| pa | PA | text | no |
| venue_type | Venue Type | text | no |
| dma | DMA | text | no |
| venue_code | Venue Code | text | no |
| owner_name | Owner Name | text | no |
| owner_phone | Owner Phone | phone | no |
| owner_email | Owner Email | email | no |
| payee_name | Payee Name | text | no |

Import mapping: spreadsheet header → `normalize_column` → match a schema key or `source_column`; unknown
columns are offered in the review UI to add to the schema or ignore. `store_name` and `addr` are always required.

### 3.2 Routing concurrency (the version fence)

- Enqueueing any routing job: `UpdateItem META SET routing_status=building, routing_job_id=:job`
  with `ConditionExpression: routing_status <> :building OR updated_at < :stale` (stale = 20 min ago).
  Failure → 409 "routing in progress".
- Job finishing: write stop diffs (`installer/day/seq`) with `attribute_exists(PK)`, then
  `UpdateItem META SET routing_status=ready, routing_job_id="" ConditionExpression routing_job_id = :job`.
  If that condition fails, another job superseded this one: log and exit without further writes.
- On exception: `routing_status=failed`, `routing_job_id=""`, job `failed` with message.

### 3.3 Jobs

Event the API sends to the worker (`InvocationType=Event`), also the shape `handlers/worker.py` dispatches on:

```json
{"job_id": "…", "job_type": "import_parse" | "routing_build", "project_id": "…", "...": "job-specific"}
```

Routing build modes (`payload.mode`): `create` (initial `build_project_routes`), `recluster`
(`build_project_routes` over all stops, statuses preserved), `rebalance` (`clean_territory_outliers` +
`rebalance_incomplete_routes` over Incomplete stops only), `add_installer` (`split_territory_for_new_installer` +
`rebalance_incomplete_routes`, `payload.new_installer`). Port the orchestration from v1
`backend/server.py` (`rebalance_project_incomplete`, `recluster_project`) but keyed by `uid`, never by the
legacy composite stop key. `per_day` is always `project.stops_per_day`.

**Local development without Lambda/S3** (task B4): `DT_WORKER_MODE=inline` runs the job in a background thread
inside the API process; `DT_FILES_BUCKET` empty switches `FileStore` to a local directory
(`backend/.local-files/`) and the upload step becomes `PUT /api/jobs/{job_id}/upload` (raw body). In AWS the
presigned S3 URL is used and the local upload route returns 404.

### 3.4 Import result (what the worker writes to `jobs/<job_id>/result.json`)

```json
{
  "columns": ["store_name", "address", "pa", "..."],
  "address_column": "address", "store_column": "store_name",
  "extra_columns": ["owner_phone"],
  "summary": {"total": 120, "valid": 110, "needs_review": 8, "invalid": 2},
  "pa_names": ["North"],
  "rows": [{
    "index": 0, "address": "<as uploaded>", "store_name": "…", "pa": "…",
    "status": "valid" | "needs_review" | "invalid",
    "confidence": 100 | 70 | 40 | 0, "verified_by": ["geocoding", "places"],
    "formatted": "…", "addr": "…", "city": "…", "state": "TX", "zip": "75201", "lat": 0.0, "lng": 0.0,
    "place_name": "…", "suggestions": ["…"], "error": "…",
    "venue_status": "Complete", "venue_status_valid": true, "venue_status_raw": "complete",
    "fields": {"venue_type": "…", "dma": "…", "venue_code": "…", "owner_phone": "…"}
  }]
}
```

Status rules are v1's: geocode ok + places ok + not partial → valid/100; geocode ok, no places → valid/70;
geocode partial → needs_review/40; geocode failed → needs_review/0 with autocomplete suggestions; blank
address → invalid. The route address always comes from the geocoding result, never from Places.

---

## 4. API contract

All paths under `/api`. `Page[T] = {items: T[], next_cursor: string | null}`.

| Method | Path | Body / query | Returns | Notes |
|--------|------|--------------|---------|-------|
| GET | `/health` | | `{status, env, db, ts}` | done |
| GET | `/config/maps` | | `{google_maps_browser_key}` | key is referrer-restricted in Google Cloud |
| GET | `/places/validate` | `address` | geocode result dict | sync, single address |
| GET | `/places/autocomplete` | `q` | `{suggestions: string[]}` | |
| GET | `/projects` | `limit, cursor` | `Page[ProjectSummary]` | summary = Project + `kpi` (§4.1), done except kpi |
| POST | `/projects` | `ProjectCreate` (§4.2) | 202 `{project, job_id}` or 201 `{project}` when no stops | routing job if installers and stops |
| GET | `/projects/{id}` | | `Project` | META only, no stops |
| PATCH | `/projects/{id}` | partial Project metadata incl. `stops_per_day`, `field_schema`; optional `expected_version` | `Project` | installers change only via installer endpoints |
| DELETE | `/projects/{id}` | `confirm=<exact name>` | 204 | deletes META + all stops |
| GET | `/projects/{id}/routes` | | `{installers, stops_per_day, routing_status, routes: {installer: Stop[][]}, stats: {installer: {total, days, avg_stops, miles}}}` | whole project; days ordered, stops by `seq` |
| GET | `/projects/{id}/stores` | `limit, cursor, status, installer, q, sort, dir` | `Page[Stop]` | §4.3 |
| GET | `/projects/{id}/stores/pins` | `status, installer, q` | `Pin[]` = `{uid, lat, lng, status, store_name, installer, day}` | whole project, located stops only |
| GET | `/projects/{id}/stores/export.csv` | same filters as list | `text/csv` | core columns + schema columns + status/comment |
| POST | `/projects/{id}/stores/append` | `{stops: StopInput[], pa?}` | `{appended, skipped: [{addr, venue_code, reason}], total}` | sync; greedy placement (v1 `append_project_stops`); dedupe by `duplicate_key` |
| GET | `/projects/{id}/stores/{uid}` | | `Stop` | |
| PATCH | `/projects/{id}/stores/{uid}` | `{store_name?, addr?, city?, state?, zip?, fields?}` | `Stop` | validates required + types; address change → geocode (422 with suggestions on partial/failure); sets `route_stale` |
| PATCH | `/projects/{id}/stores/{uid}/progress` | `{status?, comment?, additional_task?, installer_name?, updated_by?}` | `Stop` | progress attributes only |
| POST | `/projects/{id}/stops/{uid}/reassign` | `{installer}` | `{old_installer, installer, changed: uid[]}` | sync, `reassign_stop_preserving_days` |
| POST | `/projects/{id}/installers` | `{name}` | 202 `{job_id}` | routing job mode `add_installer` |
| POST | `/projects/{id}/installers/rename` | `{old_name, new_name}` | `Project` | sync; rewrites `installer` (and equal `installer_name`) on affected stops |
| POST | `/projects/{id}/routing/rebalance` | | 202 `{job_id}` | |
| POST | `/projects/{id}/routing/recluster` | | 202 `{job_id}` | |
| POST | `/jobs/imports` | `{filename, content_type, project_id?}` | `{job_id, upload_url, upload_key}` | presigned PUT (or local route) |
| PUT | `/jobs/{job_id}/upload` | raw bytes | 204 | local mode only |
| POST | `/jobs/{job_id}/start` | | 202 `Job` | verifies the upload exists, invokes worker |
| GET | `/jobs/{job_id}` | | `Job` + `result_url` when succeeded | poll every 1–2 s client-side |

### 4.1 KPI (port of v1 `kpi_summary`, computed on read)

`{total, complete, pending, technical, other, by_status, by_installer, by_dma, by_venue_type,
address_status: {total, complete, pending}}` where `by_dma`/`by_venue_type` read `fields.dma` /
`fields.venue_type` and `address_status` counts unique normalised addresses whose records are all Complete.
For `GET /projects`, compute per project with a projected Query (status, installer, installer_name, fields,
addr, city, state, zip) fanned out over a `ThreadPoolExecutor(8)`.

### 4.2 `ProjectCreate`

```
name*, pa*, project_type* (enum), installers* (≥1), field_agent, partner_account,
pa_percentage*, dolphin_percentage*, store_percentage?, fa_percentage?   (each 0–100),
stops_per_day (1–50, default 8), field_schema? (defaults to §3.1),
stops: StopInput[]  where StopInput = {store_name*, addr*, city, state, zip, lat, lng, geocoded,
                                       fields: {}, initial_status?: "Incomplete"|"Complete"|"Technical Issue"|"Other"}
```
Server mints `id`, `uid` per stop, `display_id = S1..Sn` in input order, `seq` = input index, `day = 1`,
`installer = ""` until the routing job assigns. Validation failures → 422 listing every bad row index.

### 4.3 Store list semantics

Projects are ≤ ~1000 stops, so the service loads all stops of the project once (`list_all`), applies
`status`/`installer` filters, free-text `q` over store_name/addr/city/zip/fields values/comment, sorts by
`sort` (`store_name` default, `addr`, `status`, `installer`, `day`, `updated_at`, or `fields.<key>`), and
paginates with an offset cursor (`encode_cursor({"offset": n})`). This keeps the API contract paginated while
avoiding DynamoDB filter expressions that cannot do text search. Document this in the service docstring.

---

## 5. Tasks

Sizes: S (≤ ½ day), M (≈ 1 day), L (2+ days). Dependencies are explicit. Within a phase, tasks without a
dependency can run in parallel.

### Phase 2 — Backend

**B1 · Field schema + validation (S)** — `domain/schema.py`: `DEFAULT_FIELD_SCHEMA`, `validate_fields(schema,
fields) -> list[str]` (required, select options, phone `[+()\d\s.-]{7,20}`, email, number), `coerce_fields`.
Tests for each rule. *Depends on:* nothing.

**B2 · Store repository (M)** — implement `DynamoStoreRepository`: `put_many` (batch_writer, 25/req, retries
handled by boto3), `get`, `list` (Query `PK = :pk AND begins_with(SK, 'STOP#')`, Limit, cursor),
`list_all` (paginated loop), `update_fields` (UpdateItem, `attribute_exists(PK)`, names/values built like
`DynamoProjectRepository.update`), `update_routing_many(project_id, changes)` (threaded UpdateItems, 16 workers),
`delete_all`. Add `InMemoryStoreRepository` to `repositories/memory.py`. moto tests for every method incl.
pagination and 30+ item batch. *Depends on:* nothing.

**B3 · Job repository + worker invoker (S)** — `DynamoJobRepository` (`put` with `ttl`, `get`, `set_status`,
`set_result`), `InMemoryJobRepository`, `services/worker_invoker.py` with `LambdaInvoker`
(`boto3.client("lambda").invoke(InvocationType="Event")`) and `InlineInvoker` (thread) selected by
`DT_WORKER_MODE`. Tests with moto + fakes. *Depends on:* nothing.

**B4 · Local file store (S)** — `LocalFileStore` in `repositories/files.py` used when `DT_FILES_BUCKET` is
empty; `FileStore` protocol shared; `PUT /jobs/{job_id}/upload` local route. *Depends on:* B3.

**B5 · Import job end to end (L)** — `POST /jobs/imports`, `POST /jobs/{id}/start`, `GET /jobs/{id}`;
`ImportService.run`: fetch, `parse`, geocode with `ThreadPoolExecutor(8)` (one `GoogleGeocoder` per job,
`httpx.Client` reused), progress every 10 rows, result per §3.4 to the file store, job status transitions,
failure path. Geocoder mocked in tests via a fake `GoogleGeocoder`. Verify locally with `DT_WORKER_MODE=inline`
and a real key (document the manual check in the PR). *Depends on:* B3, B4.

**B6 · Project create + routing job (L)** — `ProjectService.create` per §4.2; `POST /projects`;
`RoutingService.run_build` for modes `create` and `recluster` with the fence in §3.2; `JobRepository` wiring in
`handlers/worker.py`; `GET /projects/{id}/routes` bundle with stats (miles via `route_optimizer.route_miles`).
Tests: service with fakes (fence success, superseded job, failure path), router 202 flow, worker dispatch.
*Depends on:* B1, B2, B3.

**B7 · Store endpoints (M)** — list (§4.3), pins, get, PATCH details (validation via B1, geocode on address
change, `route_stale`), PATCH progress, export.csv. Tests for filters/sort/cursor, validation errors,
geocode-failure 422 with suggestions, progress-only writes. *Depends on:* B1, B2.

**B8 · Installers + routing operations (M)** — `POST installers` (mode `add_installer`), `installers/rename`
(sync), `routing/rebalance`, `routing/recluster`, `stops/{uid}/reassign` (sync via
`reassign_stop_preserving_days`, build the `routes` dict from stops ordered by `seq`). Port the v1 orchestration
(`rebalance_project_incomplete`) keyed by uid. Tests with fakes covering each mode and the 409 when a job is
running. *Depends on:* B6.

**B9 · Append stops + delete + patch (S)** — `POST stores/append` (v1 greedy placement, dedupe, `display_id`
continues from max `S<n>`), `DELETE /projects/{id}?confirm=`, `PATCH /projects/{id}` incl. `stops_per_day`
and `field_schema` validation. Tests. *Depends on:* B2.

**B10 · Project list KPI (S)** — §4.1 on `GET /projects`; `ProjectSummary` model; thread-pool fan-out. Tests
with fakes; one moto test with two projects. *Depends on:* B2.

**B11 · Places + config endpoints (S)** — `/places/validate`, `/places/autocomplete`, `/config/maps`. Tests with a
fake geocoder. *Depends on:* nothing.

**B12 · Migration script (M)** — `scripts/migrate_from_mongo.py` (pymongo as a script-only dependency, not in
`pyproject` runtime deps): reads v1 `projects` + `route_planner_stop_states`, joins state by recomputing the
legacy key `atl-route-v2|installer|id|addr|lat|lng`, mints `uid`, derives `seq` from array order within
`(installer, day)`, moves legacy top-level attrs (`pa`, `venue_type`, `dma`, `venue_code`, `owner_*`,
`payee_name`) into `fields`, maps `modem`/`additional_task`, writes META + stops, `--dry-run`, `--include-legacy`
for `atlanta-default` (default skip), and prints a parity report (counts + per-project KPI old vs new). Test the
transform function on a fixture; the DB round trip is manual. *Depends on:* B2, B10.

**B13 · Lambda smoke in dev (S)** — `make infra-deploy ENV=dev`, put the SSM key, hit `/api/health` through
CloudFront, run one import job and one routing job against the deployed stack, record results in the PR.
*Depends on:* B5, B6.

### Phase 3 — Frontend core + Stores

**F1 · Typed API client (S)** — `openapi-typescript` generating `src/lib/api/schema.d.ts` from
`http://localhost:8080/api/openapi.json` (npm script `gen:api`, committed output); thin typed helpers per
resource using `lib/api/client.ts`; TanStack Query hooks per endpoint in `src/features/*/api.ts`. *Depends on:*
B6, B7 (endpoints exist).

**F2 · shadcn/ui primitives (S)** — add via `npx shadcn@latest add`: button, input, label, select, dialog,
badge, card, tabs, table, progress, popover, dropdown-menu, sheet (drawer), toast/sonner, tooltip, checkbox,
textarea. Keep v1's visual language (brand `#0F5B7C`, mono labels). *Depends on:* nothing.

**F3 · Dashboard (M)** — port of v1 `Dashboard.jsx`: KPI cards, three charts (Recharts), project cards with
progress, tabs all/ongoing/completed, project filter popover, health badge; pages through `GET /projects` to
aggregate; card actions open edit/delete/append/import dialogs. *Depends on:* F1, F2, B10.

**F4 · Import wizard (L)** — three steps as v1 (details → upload → review) on the new job flow: presigned PUT
(or local route), poll `GET /jobs/{id}` with real progress, review table with status chips/filters, suggestion
picker, revalidate on blur (`/places/validate`), column-to-field mapping step (auto by alias, manual override,
"add to schema" for unknown columns), then `POST /projects` and navigate to the project with the routing banner.
Also the Append flow reusing the same upload/review components. *Depends on:* F1, F2, B5, B6, B9.

**F5 · Project shell + Settings (S)** — header with name/type/PA, routing status banner polling
`GET /projects/{id}` while `building`, tabs; Settings tab: metadata form, `stops_per_day`, installers (add →
job, rename), field schema editor (add/remove/reorder, type, required, options). *Depends on:* F1, F2, B8, B9.

**F6 · MapView (M)** — `src/components/map/MapView.tsx` on `@vis.gl/react-google-maps` +
`@googlemaps/markerclusterer`: status-coloured pins (same colours as v1 `STATUS_MAP`), same-address stacking
with count badge, legend toggles, fit-to-bounds, clustering below a zoom threshold, controlled `selectedId` /
`hoveredId` props, `onSelect`, optional "only in view" callback exposing bounds. Key from `GET /config/maps`.
Unit-test the grouping/stacking helpers. *Depends on:* F1, B7 (pins).

**F7 · Stores tab (L)** — layout: table left, map right (stack on mobile). Table on TanStack Table + Virtual:
core columns + schema columns, status chip, installer, day; sort/filter/search mapped to the list endpoint;
inline edit for text cells and a drawer (sheet) for full edit; required name/address enforced client-side with
the same rules as B1; address edit shows geocode result and suggestions on 422; progress controls (status,
additional task, comment) call the progress endpoint with optimistic updates; CSV export link; row hover ↔ pin
highlight, pin click ↔ row select/drawer. *Depends on:* F1, F2, F6, B7.

### Phase 4 — Routes tab

**R1 · Routes tab port (L)** — from `frontend/public/route-planner.html` (v1): installer tabs with stats
badges, day cards (ordered stops, status counts, cities strip, territory tag), per-stop editing reusing the
Stores drawer, reassign with confirmation (sync endpoint), rebalance/recluster buttons → jobs with the banner,
Google Maps route links chunked at 10 stops (`mapsUrlForStops` logic), copy addresses, per-day and all-days CSV,
summary table view, filters (day, PA, DMA, venue type, state, city, search). *Depends on:* F5, F7, B8.

**R2 · Remove the iframe path (S)** — nothing in v2 references `route-planner.html`; confirm and delete any
leftover references in v2 docs. *Depends on:* R1.

---

## 6. Definition of done (per task)

- Acceptance criteria above met; endpoints appear in `/api/docs` with response models.
- `make backend-lint backend-test frontend-typecheck frontend-test` green; new tests added for new behaviour.
- No change outside `v2/` (and `.github/workflows/v2-ci.yml` if CI needs it).
- `CHECKLIST.md` ticked; PR description has: what changed, how verified (commands + manual steps), any new
  dependency and why, any deviation from this document and why.

## 7. Review bar (what the reviewer checks first)

1. Layering violations (boto3 in a service, rules in a router, I/O in domain).
2. Routing and progress attributes mixed in one write; legacy composite stop key reappearing anywhere.
3. Pagination missing or cursor not opaque; `Decimal` leaking into responses.
4. Work on the request path that belongs on the worker; fence (§3.2) not applied.
5. Tests that only exercise fakes where a moto test is required, or missing failure-path tests.
6. Frontend: `any`, hand-written API types, server state in Zustand, missing loading/error states.
7. Secrets or keys in code; CORS wildcard with credentials.

## 8. Decisions already made (do not re-open; ask in the PR if one blocks you)

- Store list filtering/search happens in the service over the whole project, with offset cursors (§4.3).
- Jobs are started by an explicit `POST /jobs/{id}/start` rather than S3 event triggers.
- Local dev runs jobs inline and stores files on disk; the same services are used in both modes.
- KPIs are computed on read; no counters on the project item (see `PLAN.md` Part 1 #3).
- `display_id` is for humans; `uid` is the key. Nothing joins on `display_id`.
- The legacy `atlanta-default` project is skipped by the migration unless `--include-legacy` is passed.
- The optimizer is not modified; the per-day cap is `project.stops_per_day`, default 8 until the user sets it.

---

# Round 2 (added 2026-10-16 after review of round 1)

Round 1 (B1–B12, F1–F7, R1–R2) is merged on `tech-stack-migration`. The user's answers to `STORE-MODEL.md` §7 are
final; apply them as written. Round 2 has three parts: §9 decisions on the
questions logged in `REVIEW-NOTES.md`, §10 review fixes, §11 the store model v2 from `STORE-MODEL.md`. Same
rules (§2), same definition of done (§6). Append new sections to `REVIEW-NOTES.md` under a "Round 2" heading.

## 9. Decisions on the round-1 questions

| # | Question | Decision |
|---|----------|----------|
| 1 | Browser Maps key in AWS; S3 CORS `*` fallback | Add `google_browser_key` to `infra/config.py` `EnvConfig` (public, referrer-restricted) and pass it as `DT_GOOGLE_BROWSER_KEY`. Never fall back to `*`: dev may list `http://localhost:5173` plus the CloudFront domain once known; prod must list explicit origins and `cdk synth` fails if the list is empty. |
| 2 | `LambdaInvoker` with boto3 in `services/` | Move it to `repositories/worker_invoker.py` (persistence-style adapter). Services receive the invoker by injection, as now. |
| 3 | Google cost; no-key imports | Skip the Places call when geocoding fails (nothing to confirm); keep it on partial matches. In non-local envs an import start with no server key fails fast with 422 "Google key not configured". Local keeps today's behaviour with a warning in the job message. |
| 4 | `stop_count` never decremented | Keep as informational; KPIs are authoritative. Add a one-line docstring saying so. |
| 5 | Address edit always 422 without a key | Keep. Put the key in `backend/.env` for development. |
| 6 | Schema edits don't rewrite data | Accept. In Settings, removing a field that has values shows the count and asks for confirmation. |
| 7 | Prod parity run | Phase 5 cutover, with the user. |
| 8 | CI drift check for the generated client | Yes: a CI job that installs the backend, runs `make gen-api`, and fails on `git diff --exit-code`. |
| 9 | Lazy-load dashboard charts | Yes, `React.lazy` for the chart row now. |
| 10 | Map ID for advanced markers; cluster threshold | `VITE_GOOGLE_MAP_ID` from `GET /config/maps` (`google_map_id`, env `DT_GOOGLE_MAP_ID`); the user creates the Map ID in Google Cloud. Threshold zoom ≤ 11 stays. |

Also decided: duplicate detection changes with the store model (§11): `external_id` first, then normalised
address, regardless of venue code. The v1 rule (venue code, else address) is retired.

## 10. Review fixes

Findings from the round-1 review, verified in the code. Severity: should-fix items first. Each is one commit
("X3: optimistic status on day cards"), with a test that would have caught it where one is named.

### 10.1 Frontend

**X1 · Map refits on status changes (should-fix)** — `components/map/MapView.tsx:137-167`: the rebuild/fit
effect keys on a signature that includes each group's `status`, so an optimistic recolour (progress edit) or a
legend toggle clears all markers and calls `fitBounds`, snapping the user back out. Fix: fit only on a
locations-only signature (group keys); let the emphasis effect restyle icons with `setIcon`. Extract the
signature and emphasis-diff helpers into `components/map/pins.ts` and unit-test them.

**X2 · Stores tab stale after a routing build (should-fix)** — the "left building" transition is handled only
in `features/routes/RoutesTab.tsx:55` and invalidates only `keys.routes`. Move the transition effect to
`ProjectPage` and invalidate `keys.project(id)` (prefix covers stores list, pins, routes, detail). Test: build
finishes while Stores is open → list refetches.

**X3 · Day-card status select is not optimistic (should-fix)** — `useUpdateProgress.onMutate`
(`features/stores/api.ts`) patches store list pages, pins and the detail, never `keys.routes(id)`, so
`DayCard`'s select shows the old value until the bundle refetches. Fix: patch the stop inside the cached
`RoutesBundle` in `onMutate` with rollback in `onError`. Test: status change from a DayCard updates immediately.

**X4 · Append retry resends a stale `expected_version` (should-fix)** — `features/imports/ImportWizard.tsx:108-119`
PATCHes the schema with `appendTo.version` from the dashboard prop, then appends; if the append fails (409
routing in progress, 422, network) a retry re-PATCHes with the old version and gets 409 forever. Fix: remember
that the schema PATCH succeeded (or use the returned `project.version`) and skip it on retry. Test: failed append
→ retry succeeds.

**X5 · Import wizard stalls silently on fetch errors (should-fix)** — `ImportWizard.tsx:73-82, 178-188`: if
`GET /config/field-schema` or the `result_url` fetch errors, the job shows "succeeded 100%" and nothing
happens. Render `defaults.isError` / `result.isError` with the message and a retry button. Test for each.

**X6 · Dashboard counts stale after Append (should-fix)** — `useAppendStores.onSuccess` invalidates
`keys.project(projectId)` only; the list key `["projects","list",limit]` is not under it. Also invalidate
`keys.projects`. Test: append → dashboard card total updates.

**X7 · Map and table performance (should-fix)** — (a) `MapView.tsx:170-185` restyles every marker on each hover
change (1000 `setIcon` calls per row hover at full size): diff previous vs next emphasized uids and restyle only
those. (b) `onBoundsChanged` publishes bounds into Zustand on every drag frame and `StoresTab` subscribes to the
whole UI store, re-rendering the virtualized table: publish bounds only when "only in view" is on (or on `idle`),
and select slices from the store. No test required; note the before/after in REVIEW-NOTES.

**X8 · Minor fixes (one commit)**
- `features/imports/api.ts:40` `useJob`: stop polling when `query.state.status === "error"`.
- 409 handling in `ProjectDialogs.tsx`, `DetailsSection.tsx`, `SchemaEditor.tsx`: on `ApiError.status === 409`
  invalidate `keys.project(id)` and `keys.projects` so the retry picks up the new version.
- `features/stores/api.ts:52-56`: after a detail edit, invalidate the list only when the address or the current
  sort key changed; the per-page patch already covers the rest.
- `features/stores/EditableCell.tsx`: guard `commit()` with `if (saving) return;` (Enter + blur double PATCH).
- `ImportWizard.tsx:194-196`: show "Continue to review" when `result.data` exists after going back to upload.
- `ProjectDialogs.tsx:75-79`: send the trimmed confirm name.
- Tests: EditableCell Enter/blur/Escape; `useJob` stop condition; wizard error states (X5).

**X9 · v1 fidelity gaps, confirm with the user before doing (minor)** — city filter options narrowed to the
selected state; per-installer done/upcoming strip and project totals in the Routes header (v1 counted by
`installer_name` with route-owner fallback); the DMA/venue-type breakdown panel; day-card header click toggles
collapse. Ask which of these matter; the S8 filters work supersedes the first.

Deferred, not a defect: the CSV export link cannot carry a bearer token; handle in Phase 6 (signed download URL
or fetch-and-save). `Page<T>` in `lib/api/types.ts` is an accepted generic alias of the generated page types.

### 10.2 Backend

Baseline confirmed by the reviewer: 211 tests pass; `domain/route_optimizer.py` is byte-identical to v1; the
legacy composite key appears only in `domain/migration.py`; the routing fence (§3.2) behaves as specified under
moto tests; routing and progress writes are disjoint.

**Y1 · Job runners are not idempotent on redelivery (should-fix)** — `services/routing.py` `run_build` sets
RUNNING unconditionally, then treats `routing_job_id != job_id` as superseded, so a redelivered event for a
finished job (Lambda async invoke is at-least-once) flips SUCCEEDED → RUNNING → FAILED. `services/imports.py`
`run` re-runs the whole geocode pass. Fix: at the top of both runners, if the job is already SUCCEEDED or
FAILED, log and return. Test: deliver the same event twice; status history stays `[queued, running, succeeded]`.

**Y2 · Decodable but wrong-shape cursor → 500 (should-fix)** — `repositories/dynamo.py` `decode_cursor`
accepts any JSON; a list/str/int cursor crashes `services/stores.py` (`.get` on a list) and
`DynamoProjectRepository.list` (botocore ValidationException). Verified: base64 of `[1]`, `"str"`, `5` all 500
on `/projects` and `/projects/{id}/stores`. Fix: `decode_cursor` raises `ValueError` unless the payload is a
dict; translate botocore `ValidationException` on `ExclusiveStartKey` to `ValueError`. Tests for both routes.

**Y3 · Stops on an installer not in `project.installers` vanish from `/routes` and 500 on reassign
(should-fix)** — `services/routing.py` `group_routes` keeps only listed installers; `reassign` then raises
`LookupError`, unmapped. Reachable after a crash between the two non-atomic writes in `rename_installer`, after
the race in Y4, or via migration when a v1 doc has an empty installers list (v1 derived installers from stops).
Fix: build groups from `project.installers ∪ {stop.installer for stops}` so nothing is hidden; map
`LookupError` → `NotFoundError`; in the migration derive installers from stops when the doc has none and add a
"stops on unlisted installer: N" line to the parity report. Tests for `/routes`, `reassign`, migration.

**Y4 · Region is not passed to the Lambdas (should-fix before B13)** — `config.py` defaults `aws_region` to
us-east-1 and `infra/stacks/api_stack.py` never sets `DT_AWS_REGION`, so a deploy to any other region points
every boto3 client at the wrong one. Fix: default `aws_region` from the runtime's `AWS_REGION` env var when
present, and set `DT_AWS_REGION` in `common_env`.

**Y5 · `add_installer` can overwrite a concurrent rename (minor)** — it reads `project.installers`, then writes
the whole list in `begin_routing`. Fix: `SET installers = list_append(installers, :new)` or condition
`begin_routing` on `version`. Test with fakes.

**Y6 · `append` checks routing status but does not hold the slot (minor)** — `services/stores.py` reads
`routing_status`, then writes; a build enqueued in between computes over the old stop set. Fix: claim the slot
with a `sync-*` token for the duration, as `RoutingService._sync_slot` does.

**Y7 · `rename_installer` writes `installer_name` serially (minor)** — hundreds of sequential UpdateItems on the
request path at 600 stops. Use the same thread pool as `update_routing_many`.

**Y8 · Parsing edges (minor)** — `domain/parsing.py`: the cp1252 fallback should use `errors="replace"` (bytes
0x81/0x8D/0x8F/0x90/0x9D fail today); an empty CSV header cell becomes `fields[""]` and later 422s "Unknown field
''" — apply the XLSX `column_N` fallback in the CSV reader. Tests for both.

**Y9 · Migration value handling (minor)** — `domain/migration.py`: `_day("2.0")` falls to 1, use
`int(float(value))`; Mongo datetimes are stringified without `T`/timezone, normalise with `.isoformat()` so
`updated_at` sorts and compares with `now_iso()` values.

**Y10 · Layering tidy-up (minor)** — move `LambdaInvoker` out of `services/` (§9 #2); move `encode_cursor` /
`decode_cursor` into a boto3-free module (`domain/cursors.py`) so services stop importing
`repositories.dynamo`.

**Contract notes (no change needed, §4 updated by these lines):** `POST /projects` with no stops returns 201
`{project, job_id: null}`; `POST /jobs/imports` returns 201; `DELETE` with a wrong confirm returns 400;
`GET /config/field-schema` and the local-only `GET /jobs/{id}/result` are additive.

**Test gaps to close with the fixes above:** same-event redelivery for both runners (Y1); wrong-shape cursor on
both list routes (Y2); a stop on an unlisted installer in `/routes` and `reassign` (Y3); append racing an
enqueued build (Y6).

## 11. Phase 5 — Store model v2 (spec: `STORE-MODEL.md`)

Read `STORE-MODEL.md` fully first. The generic `field_schema`/`fields` machinery from B1 stays for unrecognised
columns only; the listed fields become first-class attributes on the stop. Keep the v1 optimizer untouched; the
only routing change is which stops count as pending.

**S1 · Domain model v2 (M)** — `domain/models.py`: `ScreenStatus` enum (§4.2), `Screen` model, the new `Stop`
attributes (§2, tri-state bools as `bool | None`), `derive_store_status(screens)`, `PENDING_STATUSES`,
`STATUS_ALIASES` + `normalize_screen_status`, `StopInput` with `external_id`, `screens`, committed counts.
`domain/validation.py` (or extend `schema.py`): per-field rules for phone, email, url, select, int ≥ 0,
non-empty for the three required fields, `external_id` normalisation (trim, upper, collapse spaces). Remove the
old `StopStatus` usages or alias them for the migration script only. Tests for derivation precedence, aliases,
tri-state parsing. *Depends on:* nothing.

**S2 · Import mapping v2 (L)** — `services/imports.py`: the §6 header map, screen rows from comma lists and
"No of Sticks", committed ints, tri-state bools, status precedence (STATUS then Shipment/Device status), sheet
lat/lng kept when geocoding fails (`needs_review`, not `invalid`), unrecognised columns into `fields`.
Dedupe in `ImportService` output: mark rows `duplicate` with reason `external_id` / `address` against earlier
rows in the sheet (project-level dedupe happens on create/append). Persist the mapping used on the project as
`import_mappings` and apply it first on the next sheet. Tests on a fixture built from the sample header with 4–5
rows (fake the geocoder). *Depends on:* S1.

**S3 · Repository + uniqueness (M)** — `external_id` marker items `SK=EXT#<normalised>` written in the same
`TransactWriteItems` as the stop on create/append (`attribute_not_exists`; `external_id` is never edited), removed
on delete. Project-level
address dedupe in the service (normalised address set over `list_all`). `StoreRepository.update_screens` writes
`screens` + derived `status` + `updated_*` only. moto tests incl. the conflict path. *Depends on:* S1.

**S4 · Store API v2 (M)** — `PATCH …/stores/{uid}` accepts the §2 editable fields incl. the two committed counts
(reject `external_id`, `pa`, routing and progress fields with 422); `PUT …/stores/{uid}/screens`; `GET …/stores/filters`;
`GET …/stores/by-state?pending=true`; list filters `pa, state, city, dma, venue_type, dd_code, screen_size`;
`GET …/stores/export.csv` columns = §2 fields in §3 order + one row per store with screen rows joined (`;`).
`PATCH …/progress` loses `status` (status is per screen). KPI v2 per `STORE-MODEL.md` §5 in `GET /projects` and
`GET /projects/{id}`. Regenerate the frontend client (`make gen-api`). Tests for each endpoint and filter.
*Depends on:* S1, S3.

**S5 · Routing pending set (S)** — `RoutingService` and the routes bundle use `PENDING_STATUSES` on the derived
status; "Route complete" and `routableStops` logic in the frontend follow. Tests updated. *Depends on:* S1.

**S6 · Migration v2 (S)** — `scripts/migrate_from_mongo.py` applies `STORE-MODEL.md` §4.4; the parity report
compares v1 status counts to derived statuses. Transform tests on a fixture. *Depends on:* S1.

**S7 · Store drawer + table v2 (L)** — drawer sections in §3 order, tri-state checkboxes, masked SSID password,
image URL links, screens editor (editable committed counts beside the derived actual counts, rows with Add (+),
per-row status select, three checkboxes, delete row with confirm), `external_id` and `pa` read-only, geocode-on-save with split address fields and suggestions. Table columns:
IBC#, store name, city/state, derived status, screens (n, with a mini status summary), installer/day, PA, DMA,
committed Dolphin / store TVs. Tests: drawer validation, screens editor add/remove, derived status display.
*Depends on:* S4.

**S8 · Filters, top-states chart, KPIs (M)** — filter bar from `GET …/stores/filters` with greyed-out empties;
"Top states by upcoming installs" bar chart next to the map, click → State filter (toggle), other filters kept;
dashboard and project header KPIs incl. committed vs actual screens. Tests for the toggle behaviour and greying.
*Depends on:* S4, S7.

**S9 · Import wizard v2 (M)** — review table shows the §6 mapping with a re-point control per column; duplicate
rows shown with reason and excluded from save; screens preview per row; append flow identical. Tests for the
mapping override and duplicate display. *Depends on:* S2, S4.

**S10 · Routes tab follow-through (S)** — day cards show derived status and screen count; status edits route
through the screens editor; CSVs use the v2 columns. *Depends on:* S5, S7.

Order: S1 → (S2, S3, S5, S6 in parallel) → S4 → S7 → (S8, S9, S10 in parallel). The §10 review fixes come
before S1 when they touch the same files, otherwise in parallel.
