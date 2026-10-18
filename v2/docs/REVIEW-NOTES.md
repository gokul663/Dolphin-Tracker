# Dolphin Tracker v2 — Review notes

One section per task from `AGENT-HANDOFF.md` §5, in commit order: what changed, how it was verified, deviations
from the handoff and why, open questions. Every commit ran `make backend-lint backend-test frontend-typecheck
frontend-test` green before landing.

## Process deviations (apply to every task)

- **One commit per task on `tech-stack-migration`**, not one branch + PR per task as `AGENT-HANDOFF.md` §1/§6
  describe. That was the instruction for this run. The commit body carries the "Verified:" section a PR
  description would have.
- **Baseline commit `35f48b3`.** `v2/` and `.github/` were untracked. I committed them unchanged first
  (plus `*.tsbuildinfo` in `v2/.gitignore`) so each task commit shows only that task's diff.
- **CHECKLIST.md** gained a "Tasks" sub-list per phase, so each commit ticks its own task. The phase-level
  lines are ticked once every task behind them has landed.
- **Environment:** the backend venv runs Python 3.14 locally (Lambda is 3.12; `requires-python >=3.12`).
  `v2/backend/.env` does not exist, so **no Google server key is available**. The manual geocode checks
  (B5, B7, B11) are skipped and noted under each task.

---

## B1 · Field schema + validation

**Changed**
- New `domain/schema.py`, pure:
  - `DEFAULT_FIELD_SCHEMA`: the eight §3.1 entries, as a tuple so nothing can mutate it. `default_field_schema()`
    returns a fresh deep copy.
  - `validate_fields(schema, fields, *, partial=False) -> list[str]`: required, select options, phone
    `[+()\d\s.-]{7,20}` (fullmatch, same as v1), email (v1 regex), number, and date (ISO `YYYY-MM-DD`). Blank
    optional values skip the type checks. Unknown keys are reported. `partial=True` checks only the keys present,
    for PATCH: an omitted required key is fine, an explicitly blanked one is not.
  - `coerce_fields(schema, fields)`: strips text, turns blanks into `""`, and turns numbers into int/float
    (int when integral). Unknown keys pass through, because `validate_fields` is the gate.
  - `validate_schema(schema)`: key format `[a-z][a-z0-9_]{0,63}`, duplicate keys, keys that clash with core stop
    attributes (`addr`, `status`, …), empty labels, select fields without options. B9 uses this for
    `PATCH field_schema`.
- New `tests/test_schema.py` (14 tests): one or more per rule, partial mode, coercion, and schema validation.

**Verified:** `make backend-lint backend-test frontend-typecheck frontend-test`, 63 backend passing.

**Deviations:** two additions the handoff does not list: `validate_schema` (B9 needs it, and rules belong in the
domain) and `partial` mode (B7 needs it for PATCH semantics).

**Open questions:** none. The DATE type has no rule in the handoff, so I chose ISO `YYYY-MM-DD`. The frontend
date input produces that format.

## B2 · Store repository

**Changed**
- `domain/models.py`: `Stop.route_stale: bool = False` (§3.1). `ROUTING_FIELDS` / `PROGRESS_FIELDS` frozensets
  name the two write groups from rule 5, so services and repositories share one definition.
- `repositories/dynamo.py`: `build_set_expression(changes)` builds the `SET` expression, names and values.
  Every path segment is aliased, and a dotted key (`fields.dma`) sets one nested map entry, so two detail edits
  to different custom fields don't overwrite each other.
- `repositories/stores.py`, `DynamoStoreRepository`:
  - `put_many`: `batch_writer(overwrite_by_pkeys=…)`. boto3 sends 25 items per request and resubmits unprocessed
    items.
  - `get`.
  - `list`: Query `PK = :pk AND begins_with(SK, 'STOP#')`, `Limit`, cursor = the encoded `LastEvaluatedKey`.
  - `list_all`: paginated loop.
  - `update_fields`: UpdateItem, `attribute_exists(PK)`, `NotFoundError` on condition failure, always stamps
    `updated_at`, ignores `uid`.
  - `update_routing_many(project_id, [(uid, {installer?, day?, seq?})])`: `ThreadPoolExecutor(16)` over the
    *client* (thread-safe; resource objects are not), each write conditioned on `attribute_exists(PK)`. A stop
    deleted mid-build is skipped instead of being recreated as a half item. Returns the count written. Raises
    `ValueError` if a change carries anything beyond installer/day/seq. That makes rule 5 a hard guarantee on
    the routing path, not just a convention.
  - `delete_all`: keys-only Query, then batch delete. Leaves META alone.
- `repositories/memory.py`: `InMemoryStoreRepository`, same contract (SK-ordered list, offset cursor, dotted
  keys). The offset-paging helper is now shared with the project fake.
- `tests/test_store_repository.py`: one contract suite run against both moto and the fake (8 tests each), plus 2
  Dynamo-only tests (item layout; `delete_all` keeps META). Covers the 37-item batch, three-plus pages with an
  opaque cursor, nested updates, routing writes that preserve progress and skip missing stops, rejection of
  non-routing keys, and per-project deletes.

**Verified**
- `make backend-lint backend-test frontend-typecheck frontend-test`, 81 backend passing.
- Manual: against DynamoDB Local (Podman, `make ddb-up ddb-table`), 60 stops: listed in 3 pages of 25, nested
  `fields.dma` update, 60 routing writes plus one ghost skipped, `delete_all` removed 60.

**Deviations:** none from the contract. `update_routing_many` takes `(uid, changes)` pairs, the shape
`RoutingService.diff` already returns.

**Note for the reviewer:** `@mock_aws` used as a class decorator only patches methods defined on that class. The
inherited contract tests briefly ran unpatched and reached real AWS. The dummy credentials were rejected, so
nothing was written. The Dynamo suite now starts the mock in `setUp`. Use the same pattern for any future
contract-style test.

## B3 · Job repository + worker invoker

**Changed**
- `domain/models.py`: `Job.payload: dict` (§3.1, the job-specific input).
- `config.py`: `worker_mode: Literal["lambda", "inline"] = "lambda"` (`DT_WORKER_MODE`). The AWS default stays
  `lambda`, so the CDK stack needs no change. B4 makes `make backend-dev` default to `inline`.
- `repositories/jobs.py`, `DynamoJobRepository`:
  - `put` writes `entity=JOB` and `ttl = created_at + 24 h` in epoch seconds. Jobs carry no GSI1 keys.
  - `get` drops `ttl` before validation.
  - `set_status(progress=None leaves it unchanged; clamped 0–100)`.
  - `set_result(result_key)` sets succeeded at 100 %.
  - Every update is conditioned on `attribute_exists(PK)` and raises `NotFoundError`. `set_result` is the one
    method added to the stub protocol.
- `repositories/memory.py`: `InMemoryJobRepository`, plus a `history` of status transitions for service tests.
- `services/worker_invoker.py`:
  - `WorkerInvoker` protocol.
  - `LambdaInvoker`: `invoke(InvocationType="Event")`, client injectable, refuses an empty function name.
  - `InlineInvoker`: daemon thread per job, runs `handlers.worker.dispatch`, logs and swallows crashes so the API
    process survives, and has `wait()` for tests.
  - `make_invoker(settings)`.
- `handlers/worker.py`: the body moves into `dispatch(event)`, which the Lambda handler and the inline invoker
  share. B6 wires the repositories into it.
- `tests/test_jobs.py` (15 tests): the contract on moto and the fake, the TTL/layout check, invoker behaviour in
  both modes, and `make_invoker` selection.

**Verified:** `make backend-lint backend-test frontend-typecheck frontend-test`, 96 backend passing.

**Deviations**
- `LambdaInvoker` lives in `services/` and imports boto3, because the handoff puts it there. That is a narrow
  exception to rule 1, "no boto3 in services". The import is local to the constructor, and no business service
  touches boto3. If the reviewer prefers, it moves to `repositories/` (or a new `adapters/`) with no API change.

**Open questions:** none.

## B11 · Places + config endpoints

**Changed**
- `services/places.py`: `PlacesService.validate(address)` geocodes. On failure with no Google suggestions, it falls
  back to autocomplete, as v1's parse flow did. `autocomplete(q)` is also here.
- `api/routers/places.py`:
  - `GET /config/maps` → `{google_maps_browser_key}`.
  - `GET /places/validate?address=` (1–500 chars, otherwise 422) → `GeocodeResult`.
  - `GET /places/autocomplete?q=` → `{suggestions}`.
- `api/schemas.py`, new: HTTP DTOs that aren't domain records (`MapsConfig`, `GeocodeResult`, `Suggestions`).
  Later tasks add their request/response models here.
- `api/deps.py`: `get_geocoder` returns one cached `GoogleGeocoder` per key per warm process, so its
  `httpx.Client` is reused. `get_places_service` is also here.
- **Bug fix in `config.py`:** `resolve_google_server_key` was `@lru_cache`'d on a `Settings` argument, and pydantic
  models are unhashable, so passing settings raised `TypeError`. The cache now sits on a private
  `_ssm_secure_string(name, region)`. Behaviour is otherwise unchanged.
- `tests/fakes.py`: `FakeGeocoder` (configurable geocode/places/autocomplete, thread-safe call log) and
  `geocode_ok()`, reused by B5/B7.
- `tests/test_places_api.py` (8 tests): success, failure with fallback suggestions, 422 on a missing address,
  autocomplete, browser-key-only config, OpenAPI presence, and the server-key resolution (direct value; SSM
  SecureString through moto).

**Verified:** `make backend-lint backend-test frontend-typecheck frontend-test`, 104 backend passing. The manual
check against Google is **skipped**: no `v2/backend/.env`, so no server key.

**Deviations:** `/config/maps` reads settings in the router directly, as `/health` already does. A service for one
settings field would be ceremony.

**Open questions**
- `DT_GOOGLE_BROWSER_KEY` is not set by `ApiStack`, so in AWS `/config/maps` returns an empty key until it is
  wired. Options: a plain env var from `cdk.json` context, or a second SSM parameter. The browser key is public by
  nature (referrer-restricted), so an env var is fine. Which do you prefer? I have not changed infra.

## B4 · Local file store + local upload route

**Changed**
- `repositories/files.py`, rewritten:
  - `FileStore` protocol: `is_local`, `presign_upload`, `presign_download`, `exists`, `get_bytes`, `put_bytes`,
    `put_json`, `get_json`.
  - Key layout is defined once, in `upload_key(job_id, filename)` (filename sanitised to `[A-Za-z0-9._-]`, no
    path parts) and `result_key(job_id)`.
  - `S3FileStore`, the former `FileStore` class: now takes the bucket name (not `Settings`) and an injectable
    client, and gains `exists` (HEAD), `put_bytes` and `get_json`.
  - `LocalFileStore(root)`: atomic writes (`.part` + rename), and refuses keys that resolve outside the root. Its
    "presigned" URLs are the local API routes `/api/jobs/{id}/upload` and `/api/jobs/{id}/result`.
  - `make_file_store(settings)`: S3 when `DT_FILES_BUCKET` is set, otherwise local.
- **Bug fix:** the S3 client now forces SigV4 with virtual-hosted addressing. boto3 was producing SigV2
  presigned URLs (`AWSAccessKeyId=…&Signature=…`), and S3 rejects those on buckets created after 2020, so
  browser uploads would have failed in AWS. A test now asserts `X-Amz-Signature` on the default client.
- `config.py`: `local_files_dir=".local-files"` (relative to `backend/`) and `max_upload_bytes=20 MiB`.
- `services/jobs.py`, new `JobService`: `get` and `receive_upload`. `receive_upload` gives 404 when files are in
  S3 or the job takes no upload, 409 once the job has started, and `ValueError`→422 on an empty body.
- `api/routers/jobs.py`: `PUT /jobs/{job_id}/upload` (raw body, 204). Returns 413 above `max_upload_bytes`,
  checked on Content-Length and on the actual size.
- `api/deps.py`: `get_job_repository`, `get_file_store`, `get_job_service`.
- `Makefile`: `backend-dev` defaults `DT_WORKER_MODE=inline`, overridable from the environment.
  `.gitignore`: `.local-files/`.
- `tests/test_files.py` (10 tests): key layout and sanitising, the store selection, a local round trip with no
  `.part` leftovers, path escape, the local URLs, an S3 round trip plus SigV4 under moto, and the upload route's
  204/404/409/413/422 cases plus 404 when S3 is configured.

**Verified:** `make backend-lint backend-test frontend-typecheck frontend-test`, 114 backend passing.

**Deviations**
- Added a local-only `GET /jobs/{id}/result` URL scheme. The handoff has `result_url` in `GET /jobs/{id}` but only
  defines a local route for upload, and the browser needs somewhere to fetch the result in local mode. The route
  itself lands in B5. In AWS, `result_url` is a presigned S3 GET.

**Note for F4:** the presigned PUT signs `Content-Type`, so the browser must send exactly the `content_type` it
gave to `POST /jobs/imports`.

## B5 · Import job end to end

**Changed**
- `api/routers/jobs.py`:
  - `POST /jobs/imports` → 201 `{job_id, upload_url, upload_key}`. 422 for an unsupported extension, 404 for an
    unknown `project_id`.
  - `POST /jobs/{id}/start` → 202 `Job`. 409 if the upload is missing, the job has already started, or the job is
    not an import. 503 if the worker can't be invoked; the job is then marked failed.
  - `GET /jobs/{id}` → `JobView` (Job + `result_url` once succeeded).
  - `GET /jobs/{id}/result`, local mode only (see the B4 deviation).
- `services/jobs.py`: `create_import`, `start`, `view`, `result`.
  - `start` does the queued→running transition as a conditional write (`expected_status`), so a double click or a
    client retry can't launch two workers for one job.
- `repositories/jobs.py` and the fake: `set_status(..., expected_status=)` raises `ConflictError` when the job is
  no longer in that state.
- `services/imports.py`: `ImportService(jobs, files, geocoder).run`.
  1. Read the upload, `parse`, cap at 5,000 rows.
  2. Geocode with `ThreadPoolExecutor(8)` over one shared geocoder, one per job.
  3. Write progress every 10 rows (1 % reading, 5 % parsed, then 5–95 % linearly).
  4. Write `result.json` per §3.4, then `set_result`.
  - Any exception marks the job failed. `ValueError`/`KeyError` messages are shown verbatim ("Missing 'address'
    column"); others are prefixed "Import failed: …".
  - `verify_row` is the pure per-row port of v1's status rules. It always returns every §3.4 key (`None`/`""`
    defaults), so the frontend type is stable. Route address and coordinates come only from geocoding.
  - `fields` carries the venue columns the sheet actually has, plus every unknown column, keyed by normalised
    header. Mapping to the project schema happens in the review UI (F4), so the job stays schema-agnostic.
  - `ParsedTable.venue_columns` is new, so absent venue columns are not emitted as empty fields.
- `services/geocoding.py`: `GoogleGeocoder.close()`. The worker closes the per-job client.
- `handlers/worker.py`: a `WorkerDeps` container (repositories, file store, geocoder factory), with
  `default_deps()` cached per process. `dispatch(event, deps=None)` lets tests and the inline invoker run the same
  path with fakes.
- `services/worker_invoker.py`: `LambdaInvoker` now creates its client lazily and checks the function name at
  invoke time. Every job endpoint depends on the invoker, and a misconfigured env should fail the enqueue, not
  `GET /jobs/{id}`.
- `domain/models.py`: `JobView`. `api/schemas.py`: `ImportJobCreate`, `ImportJobCreated`.
- Tests:
  - `tests/test_import_service.py`: 3 parse, 6 status-rule and 5 run tests. The run tests cover the full result,
    the progress cadence, and failure paths (bad sheet, missing upload, geocoder crash, vanished job).
  - `tests/test_jobs_api.py`, 7 tests: the whole browser flow through `InlineInvoker` → `dispatch` with fakes,
    plus every error code above.

**Verified**
- `make backend-lint backend-test frontend-typecheck frontend-test`, 133 backend passing.
- Manual, local stack (`make ddb-up ddb-table backend-dev`, inline worker, `.local-files`): `POST
  /jobs/imports` → `PUT` upload 204 → `start` 202 → job `succeeded` within 1.5 s → `GET result_url` returned
  §3.4 JSON. Files landed under `backend/.local-files/{uploads,jobs}/<id>/`.
- **Real-geocode check skipped:** there is no `DT_GOOGLE_SERVER_KEY` in `v2/backend/.env`. Without a key every row
  comes back `needs_review` / 0 with error "missing key/address", which is what the manual run showed.

**Deviations**
- `find_place` is still called for every row, even when geocoding failed, to keep v1's `verified_by` semantics.
  That is one Places call per row.

**Open questions**
1. Google cost (PLAN open question 5): should the Places check be skipped when geocoding fails, or when it
   returns a partial match? It roughly halves calls on bad sheets, and the only change is `verified_by` on failed
   rows.
2. With no server key configured, the import "succeeds" with every row needing review, as v1 did. Should it fail
   fast with "Google key not configured" instead?

## B6 · Project create + routing job + routes bundle

**Changed**
- `domain/models.py`: `Project.routing_job_id`. New: `StopInput`, `ProjectCreate` (§4.2 bounds in pydantic:
  percentages 0–100, `stops_per_day` 1–50, ≥1 installer, ≤5,000 stops), `InstallerStats`, `RoutesBundle`.
- `domain/errors.py`: `ValidationFailed(message, **extra)` maps to 422 with `{"detail": {"message", ...extra}}`,
  so services can report structured rule failures without HTTP types.
- `repositories/projects.py` and the fake, the §3.2 fence:
  - `begin_routing(project_id, job_id, stale_before)`: conditional `routing_status <> building OR updated_at <
    stale`. `ConflictError` → 409; 404 if the project is missing.
  - `finish_routing(project_id, job_id, status)`: conditional `routing_job_id = :job`. Returns False when
    superseded.
- `services/routing.py`:
  - `enqueue(project_id, mode, **payload)` (used by B8): record the job, claim the slot (a conflict marks the job
    failed), invoke.
  - `record_and_launch` for create.
  - `launch`: an invoke failure marks the job failed and releases the slot as `failed`.
  - `run_build(job_id)`: mode comes from the job's payload. `create` and `recluster` run `build_project_routes`
    over all stops; B8 adds `rebalance` and `add_installer`. It checks the slot at three points: before computing,
    after computing but before writing, and at finish. A superseded job stops without touching the project or
    stops and marks its own job failed, "Superseded by a newer routing job". It writes only installer/day/seq
    diffs, then clears `route_stale` on rebuilt stops in a separate write. Any exception gives a failed project
    (conditional) and a failed job.
  - `routes(project_id)`: the bundle. Days are ascending with gaps collapsed (as in v1), stops in `seq` order,
    stats per v1.
- `services/projects.py`, `create(ProjectCreate)`:
  - Validates every rule and reports all problems at once: project-level `errors` plus `stops: [{index,
    errors}]` (required name/address, `validate_fields` against the schema). The schema defaults to §3.1.
  - Mints the project id, a uid per stop, `display_id S1..Sn`, `seq` = index, `day=1`, `installer=""`; status
    comes from `initial_status`.
  - Writes stops, then META (`building` + job id), then the job. With no stops it returns 201 with no job.
- `api/routers/projects.py`: `POST /projects` (202 `{project, job_id}`, or 201 with no stops) and `GET
  /projects/{id}/routes`.
- `handlers/worker.py`: `routing_build` runs `RoutingService(...).run_build(job_id)`.
- Tests:
  - 3 moto fence tests in `test_project_repository.py`.
  - `test_routing_service.py` rewritten, 17 tests: helpers, enqueue/conflict/invoke failure, success with
    progress preserved and stale cleared, an idempotent rerun, superseded at each of the 3 checkpoints, the
    failure path, the bundle.
  - `test_projects_api.py`, 7 tests: the 202 flow through the real worker dispatch, minted fields, 201 with no
    stops, 422 listing every bad row, pydantic bounds, a custom schema with number coercion, routes 404.

**Verified**
- `make backend-lint backend-test frontend-typecheck frontend-test`, 157 backend passing.
- Manual, local stack (DynamoDB Local, inline worker): `POST /projects` with 60 stops, 3 installers, cap 30 → 202
  `building`. The job succeeded in 0.5 s, "60 of 60 stops moved". META was `ready` with `routing_job_id` "". The
  bundle showed days ≤ 30 and stats with miles. An invalid create returned 422 with project and row errors.

**Deviations**
- **Miles skip stops without coordinates.** `route_miles` indexes `lat`/`lng` directly, so v1's stats would crash
  on a day containing an ungeocoded stop. v2 sums along the day's located stops in `seq` order. The optimizer is
  untouched.
- **A superseded job marks its own job record failed.** §3.2 says "log and exit without further writes". I read
  that as no further project/stop writes. Updating the job's own status lets the UI stop polling.
- **Create survives a worker-invoke failure.** The project and stops are already saved, so the client gets 202
  with `routing_status=failed` and can recluster. Otherwise it would get a 503 for a project that exists.
- **Write order on create:** stops, then META. If META fails there is no visible half-project, only orphan stop
  items (no META, so nothing lists them).
- **`run_build(job_id)`** replaces the stub's `run_build(project_id)`. The job carries the project id and mode.

**Open questions**
- `stop_count` is maintained on create (and append in B9) but not decremented anywhere, since there is no stop
  delete endpoint. It is informational; the KPIs (B10) count actual stops.

## B7 · Store endpoints

**Changed**
- `services/stores.py`, `StoreService(stores, projects, geocoder)`. The §4.3 semantics are in the module docstring.
  - `list(project_id, StoreQuery, limit, cursor)`: `list_all`, then filters, then free-text search, then sort,
    then an offset cursor.
    - Filters: `status` (repeatable), `installer` (repeatable; empty = unassigned).
    - `q` is case-insensitive over store_name/addr/city/zip/comment/fields values, **plus `display_id`** so
      "S12" finds a stop.
    - Sort: `store_name` (default), `addr`, `status`, `installer`, `day`, `updated_at`, `display_id` (natural
      order: S10 after S9), or `fields.<schema key>`. Text sorts ignore case; numbers sort numerically; blanks are
      always last in either direction; ties fall back to display order.
    - An unknown sort or field returns 400, as does a bad cursor.
  - `pins`: same filters, located stops only, `{uid, lat, lng, status, store_name, installer, day}`.
  - `export_csv`: same filters and order. Core columns, then schema columns by label, then status and progress.
    Text cells starting with `= + - @ \t \r` get a leading `'` (CSV formula-injection guard).
  - `update_details`:
    - Store name and address can't be blanked. `fields` is validated with `validate_fields(partial=True)`
      (unknown keys and type errors), and every problem comes back in one 422.
    - **Only when an address part actually changes**, it geocodes `addr, city, state, zip`. A partial or failed
      result gives 422 `{message, google_status, suggestions}`, with autocomplete as the fallback suggestion
      source, and nothing is written.
    - On success it sets lat/lng/geocoded and `route_stale=True`.
    - `fields` are written as one `fields.<key>` path each, so concurrent edits to other fields survive. No-op
      edits skip the write. Installer/day/seq/progress can't be in this write: the request model has no such
      keys.
  - `update_progress`: only `PROGRESS_FIELDS` (asserted); an empty body is 422.
- `api/routers/stores.py`: list, `/pins`, `/export.csv` (`text/csv`, attachment), `/{uid}`, `PATCH /{uid}`,
  `PATCH /{uid}/progress`. `api/schemas.py`: `Pin`, `StoreDetailsUpdate`, `ProgressUpdate`.
- The `Geocoder` protocol moved to `services/geocoding.py`, its natural home.
- `tests/test_stores_api.py`, 16 tests: the default sort, every sort key including blanks-last in both directions,
  400/422 for bad parameters, each filter and search target, cursor paging, 404s, pins, the CSV
  layout/filter/injection guard, detail edits with and without an address change, the 422s with suggestions
  (nothing written), validation, progress-only writes, and a spy proving the progress and detail writes carry
  disjoint key sets.

**Verified**
- `make backend-lint backend-test frontend-typecheck frontend-test`, 173 backend passing.
- Manual, local stack, on the B6 smoke project (60 stops): a page of 25 sorted desc with a next cursor, pins
  filtered by installer (17), the CSV header plus a filtered export, a progress PATCH (installer/day unchanged),
  and a nested fields PATCH. An address PATCH returns 422, because there is no Google key locally. The **real
  geocode check is skipped** for that reason.

**Deviations:** `display_id` is included in search and as a sort key; both are additions.

**Open questions:** without a Google key locally, no address can be edited (always 422), the same as v1. Fine for
dev?

## B9 · Append stops + delete + patch

**Changed**
- `services/stores.py`, `StoreService.append(project_id, stops, pa)`: a port of v1 `append_project_stops`, keyed
  by uid.
  - Dedupes with `duplicate_key`: venue code (`fields.venue_code`, case-insensitive), else the normalised
    address. Duplicates are checked against existing stops and within the batch, and reported in `skipped` as
    `{addr, venue_code, reason: "duplicate"}`.
  - Greedy placement: the installer with the fewest stops, then that installer's same-state day with room under
    `project.stops_per_day` (fewest stops, then lowest day), else a new day after their last. `seq` = end of
    that day.
  - `display_id` continues from the max `S<n>`; non-matching legacy ids are ignored.
  - Merges PA from the project, the payload and each stop's `fields.pa`, and updates `stop_count`.
  - 409 while routing is `building`. 422 when the project has no installers or rows are bad (same per-row report
    as create).
- `domain/schema.py`: `validate_stop_inputs(schema, stops)`, shared by create and append. `ProjectService.create`
  uses it now instead of its own loop.
- `services/projects.py`:
  - `update` whitelists metadata keys. It rejects null for non-nullable keys and a blank name, validates
    `field_schema` with `validate_schema`, and refuses an empty change set.
  - `delete(confirm=)` requires the exact name (v1's two-step safeguard, 400 otherwise).
- Routers:
  - `POST /projects/{id}/stores/append` → `AppendResult`.
  - `PATCH /projects/{id}` takes `ProjectUpdate` with `extra="forbid"`, so `installers`, `routing_status` etc.
    are a 422, not silently ignored. `expected_version` → 409 on mismatch.
  - `DELETE /projects/{id}?confirm=` → 204.
- `tests/test_project_edit_api.py`, 8 tests: dedupe (venue code, address, in-batch), placement across installers
  and states with `display_id` continuation, status/fields/PA merge, append errors
  (422/409/422/404), delete confirm, PATCH success (cap, nullable percentage, schema with select options),
  seven rejections, and the optimistic version.

**Verified:** `make backend-lint backend-test frontend-typecheck frontend-test`, 181 backend passing.

**Deviations**
- Append returns 409 while a routing build is running. v1 had no async builds. A build computing over the old
  stop set would place appended stops on days it is about to reuse.
- Append does not return the routes bundle as v1 did. The handoff contract is `{appended, skipped, total}`; the
  client refetches `/routes`.

**Open questions**
- Changing `field_schema` does not rewrite stop data. Values of a removed field stay in `fields`. They are hidden
  from the UI and left out of the CSV, because both follow the schema. Making a field `required` does
  not re-validate existing stops. Is that acceptable, or should a schema change that orphans data need
  confirmation?

## B10 · Project list KPI

**Changed**
- `domain/kpi.py`, pure: a port of v1 `kpi_summary` over stop rows. `Kpi`/`Breakdown` models.
  - `by_installer` prefers `installer_name`.
  - `by_dma`/`by_venue_type` read `fields.dma`/`fields.venue_type` ("Not provided" when blank).
  - `address_status` groups by v1's normalised `addr|city|state|zip` key, falling back to `missing-address|uid`
    only when every part is blank. A group counts complete when all its stops are.
  - `KPI_ATTRIBUTES` is the §4.1 projection.
- `repositories/stores.py` and the fake: `list_projected(project_id, attributes)`. A paginated Query with
  `ProjectionExpression`, every name aliased (`status` is a DynamoDB reserved word). Returns plain dicts via
  `from_ddb`.
- `domain/models.py`: `ProjectSummary(Project)` + `kpi`.
- `services/projects.py`: `list` returns `Page[ProjectSummary]`, with one projected Query per project fanned out
  over `ThreadPoolExecutor(8)`. Paging is unchanged (GSI1 cursor).
- `GET /projects` → `Page[ProjectSummary]`.
- `tests/test_kpi.py`, 4 tests: v1 rules on hand-computed data (including address grouping), an empty project, a
  moto test with two projects through the real repository and the service fan-out (projection excludes `lat`),
  and the API shape. `tests/test_api.py` now gives the app an in-memory store repository, since listing reads
  stops.

**Verified**
- `make backend-lint backend-test frontend-typecheck frontend-test`, 185 backend passing.
- Manual: `GET /api/projects` on the local stack returns the B6 smoke project with `kpi.total=60`, `complete=1`
  (from the B7 progress PATCH) and per-installer counts. That confirms the aliased projection against DynamoDB
  Local, not just moto.

**Deviations**
- No cross-project aggregate in the response. v1 returned a top-level `kpi` over all projects; with pagination,
  F3 aggregates on the client by paging through, as the handoff says.
- No `read_only` flag: the legacy external project is out of scope (§8).

**Open questions:** none.

## B8 · Installers + routing operations

**Changed**
- `services/routing.py`:
  - **Modes `rebalance` and `add_installer`:** `rebalance_assignments` is a port of v1 `rebalance_project_incomplete`
    keyed by uid. It builds the optimizer's route dicts from stops (`optimizer_routes`, ordered by seq), then the
    Incomplete set, then `split_territory_for_new_installer` (add) or `clean_territory_outliers` (rebalance), then
    `rebalance_incomplete_routes` with `project.stops_per_day`. Only Incomplete stops are re-planned.
  - `add_installer(name)`: 422 blank, 409 duplicate. **The new name is written in the same conditional
    `begin_routing` update that claims the slot** (`begin_routing(..., installers=)`). Otherwise the inline worker
    could start before the list is saved, or a 409 could leave an installer added with no routing.
  - `rebalance`, `recluster`: 422 without installers, 409 while a build runs.
  - **Synchronous ops hold the slot too.** `_sync_slot` claims it with a `sync-<uuid>` token for the few hundred
    ms of the edit, so a build can't start (or be running) underneath. Afterwards it **restores the previous
    status**, so a `failed` build stays visible.
  - `rename_installer`: 404 unknown, 422 blank, 409 taken, same name is a no-op. META installers, then a routing
    write of `installer` on that installer's stops, then a **separate** progress write of `installer_name` where it
    equalled the old name (rule 5).
  - `reassign(uid, installer)`: `reassign_stop_preserving_days` over the seq-ordered layout. Unassigned stops ride
    along under `""` so they can be moved too. Writes only the diff and returns `{old_installer, installer,
    changed}`.
- Routers (`projects.py`): `POST /installers` (202), `POST /installers/rename` (Project), `POST
  /routing/rebalance` and `/routing/recluster` (202 `{job_id}`; 503 if the worker can't be invoked), `POST
  /stops/{uid}/reassign`.
- `tests/test_installer_ops.py`, 13 tests through the API and the inline worker:
  - each mode (completed stops keep installer and day-mates; pending caps hold);
  - progress kept on recluster;
  - **409 for every routing/sync operation while a job runs**, and a failed add leaves no installer;
  - rename write groups (a spy proves no write mixes `installer` and `installer_name`);
  - rename validation;
  - reassign moves exactly one stop between installers, `changed` equals the real diff, and the slot is
    released; a same-installer reassign is a no-op;
  - errors release the slot;
  - a `failed` status survives a rename;
  - unassigned stops are untouched by rebalance.

**Verified**
- `make backend-lint backend-test frontend-typecheck frontend-test`, 198 backend passing.
- Manual, local stack, on the 60-stop smoke project: add "Dee" → job "43 of 60 stops moved". Rebalance (202)
  with a concurrent recluster → **409**, then "38 of 60 moved", giving 15/15/15/15. Reassign Ann → Dee (200).
  Rename Dee → Dana (200, `ready`). Totals afterwards were 14/15/15/16.

**Deviations / v1 behaviours worth knowing**
- **Rebalance renumbers days.** v1 drops empty days and renumbers, so a completed stop keeps its installer and
  its day-mates, but its day *number* can change. Completed stops don't count toward the cap. That is v1's
  optimizer and unchanged. The tests assert these real invariants.
- **Reassign reports many `changed` uids** (27 in the manual run). v1 re-optimizes the order of both affected
  days, so `seq` shifts on two days; installers and days elsewhere stay put.
- **Add-installer** returns 202 `{job_id}` only (handoff contract). v1 returned the whole bundle synchronously.

**Open questions:** none.

## B12 · Migration script

**Changed**
- `domain/migration.py`, the pure transform. The composite key appears **only in this module**, to join once.
  - `legacy_keys(stop)` returns both spellings of `atl-route-v2|installer|id|addr|lat|lng`. The legacy page wrote
    state with **JS** formatting (`null`→`''`, `33.0`→`33`), while v1's server code used **Python** f-strings
    (`None`, `33.0`). The join tries both, for both the stored and the repaired address.
  - `transform_project(doc, states)` returns `Project`, `Stop[]` and a `ProjectReport`:
    - uid: `uuid5(project id | position | legacy id)`, stable, so re-runs overwrite rather than duplicate.
    - `display_id` = legacy id.
    - `seq` from array order within `(installer, day)`.
    - v1 address repair (`apply_parsed_address`), which PLAN says moves off the read path, runs here.
    - Legacy attributes (`pa`, `venue_type`, `dma`, `venue_code`, `owner_*`, `payee_name`) move into `fields`.
    - **Any other non-empty attribute (e.g. `brand`) is kept** as an extra text field in that project's schema,
      not dropped.
    - From state: status, comment, `additional_task` (falling back to `modem`), `installer_name`,
      `updatedBy`/`updatedAt`, a store-name override, and a `venue_code` override (v1 detail edits stored it on
      the state).
    - `stops_per_day=8` (v1's constant).
  - `v1_kpi` replays v1's dashboard: its `kpi_summary` joined on the Python key only, with no status
    normalisation. The report compares that with the v2 `kpi_summary`.
  - `format_report` prints per-project stops / states / matched / orphans, old vs new
    complete/pending/technical/other, repaired-address and extra-field notes, and totals.
- `scripts/migrate_from_mongo.py`:
  - Options: `--dry-run`, `--include-legacy` (`atlanta-default` is skipped by default and reads the shared
    `stop_states` collection), `--project` (repeatable), `--report-json`.
  - Mongo comes from `MONGO_URL`/`DB_NAME`; the table from the `DT_*` settings.
  - For each project: `delete_all` stops, `put_many`, then put META.
- `pyproject.toml`: a `migrate` extra (`pymongo>=4`), script-only. Not in runtime deps or
  `requirements-lambda.txt`.
- `tests/test_migration.py`, 12 tests on a fixture covering each key spelling (Python, JS-integral, JS-null),
  orphans, modem→additional_task, store-name and venue-code overrides, the extra `brand` field, seq derivation,
  address repair, stable uids, the KPI parity flag, sparse-document defaults, legacy detection, and the script's
  argument guard.

**Verified**
- `make backend-lint backend-test frontend-typecheck frontend-test`, 210 backend passing.
- **Manual DB round trip:**
  1. Ran a throwaway `mongo:7` in Podman and seeded the test fixture plus an `atlanta-default` doc with a
     `stop_states` row.
  2. `--dry-run`: legacy skipped, report printed, nothing written.
  3. A real run with `--include-legacy`, run twice (idempotent), into DynamoDB Local.
  4. Through the v2 API: stores show the joined statuses, the renamed store, the `venue_code` override and
     seq 0/1/2. `/routes` grouped Ann [3, 1], Bo [1]. KPIs came back from `/projects`. The container was stopped
     afterwards.

**Finding for the reviewer (a v1 bug, surfaced by the parity report):** v1's server-side KPI looked up state with
the Python key, but the page saved state with the JS key. For stops with **integral or null coordinates**, the
old dashboard never counted saved progress (it showed them as pending). In the fixture the old KPI is 1/4/0/0 and
the new one is 1/2/1/1, so the report flags "KPI differs". On real data, expect such differences exactly for
those stops. v2's numbers are the correct ones. Each difference should be explainable from the report's matched
counts.

**Deviations**
- Extra attributes become schema fields instead of being dropped (no capability loss).
- The address repair runs during migration (PLAN: read paths stop writing).

**Open questions**
- The prod Mongo dump is needed for the real parity run (PLAN Phase 5). Not done here.
- `assigned_region` was always empty in v1 code paths. It is kept only if non-empty, like any extra attribute.

## B13 · Lambda smoke in dev: **skipped**

No AWS credentials are configured on this machine: `aws sts get-caller-identity` returns `NoCredentials` (the
`~/.aws` files exist but hold no usable profile). Per the run instructions, B13 runs only with credentials and
after asking you, so nothing was deployed. The CHECKLIST item stays unticked. To run it: configure credentials,
then `aws ssm put-parameter … google-maps-server-key`, `make infra-deploy ENV=dev`, and the checks listed in the
handoff. Two infra gaps to settle first (see B11 and below): `DT_GOOGLE_BROWSER_KEY` is not set by `ApiStack`,
and the S3 CORS rule falls back to `*` when `cors_origins` is empty.

## F2 · shadcn/ui primitives

**Changed**
- Added with `npx shadcn@latest add …` (new-york): button, input, label, select, dialog, badge, card, tabs,
  table, progress, popover, dropdown-menu, sheet, sonner (toast), tooltip, checkbox, textarea, in
  `src/components/ui/`.
- **CLI misfire, corrected.** With the `@/*` alias only in `tsconfig.app.json`, the CLI first wrote into a
  literal `frontend/@/` directory. On the second run it rewrote every `@/lib/utils` import to the unrelated npm
  package **`cn`** and installed it. Fixes:
  - added the alias to the root `tsconfig.json` (shadcn's documented Vite setup);
  - pointed all imports back at `@/lib/utils`;
  - uninstalled `cn`;
  - dropped `next-themes`. `sonner.tsx` is fixed to the light theme; the app is light-only, as v1 was.
- `src/index.css`: shadcn token layer (`--primary` = v1 brand `#0F5B7C`, ring = brand accent, slate neutrals)
  plus `@theme inline` mappings. Fonts are v1's (Bebas Neue display, IBM Plex Mono labels, IBM Plex Sans body),
  loaded in `index.html` like the legacy page. The shared **status colours** match the legacy page.
- `app/providers.tsx`: `TooltipProvider` and the `Toaster`.
- Test toolchain: Vitest now runs in jsdom with `src/test/setup.ts` (explicit Testing Library cleanup).
  `src/components/ui/primitives.test.tsx` renders Button/Badge/Checkbox and toggles the checkbox.

**New dependencies**
- `radix-ui`, `sonner`: added by the shadcn CLI; the primitives need them.
- dev `tw-animate-css`: shadcn's enter/exit animation classes; without it dialogs and sheets don't animate.
- dev `@testing-library/react`, `@testing-library/dom`, `@testing-library/user-event`, `jsdom`: rule 8 component
  tests.

**Verified:** `make backend-lint backend-test frontend-typecheck frontend-test` (2 frontend tests passing) and
`make frontend-build`.

**Deviations:** the status colour values are my reading of v1. F6 checks them against `STATUS_MAP` in
`route-planner.html` and adjusts if they differ.

## F1 · Typed API client

**Changed**
- **Generated types:** `openapi-typescript` writes `src/lib/api/schema.d.ts`, committed.
  - `npm run gen:api` reads `http://localhost:8080/api/openapi.json` (overridable via `OPENAPI_URL`).
  - New `make gen-api` dumps the spec from `create_app()` without a running server.
  - Both produce byte-identical output (checked).
- **Backend changes so the types are exact:**
  - New `domain/base.py` `ApiModel` with `json_schema_serialization_defaults_required=True`. Every domain and
    API model inherits it, so response fields with defaults are *required* in the generated types (no
    `undefined` checks) while requests keep their defaults. FastAPI now emits `FieldDef-Input` /
    `FieldDef-Output`.
  - `GET /health` → `HealthResponse`; `GET /jobs/{id}/result` → `ImportResult`/`ImportRow` (§3.4). The import
    service test now validates the real worker output against `ImportResult`, so the TS type can't drift from
    what the worker writes.
- `src/lib/api/types.ts`: aliases over `components["schemas"]` only; the old hand-written `HealthResponse` is
  gone. Two non-record helpers stay hand-written: the generic `Page<T>` shape and `ValidationDetail`, the body of
  our `ValidationFailed` 422, which FastAPI's OpenAPI doesn't describe. `ApiError.validation` exposes it.
- `src/lib/api/client.ts`:
  - Repeatable query params (`status=A&status=B`).
  - `errorMessage` reads string / `{message}` / pydantic-list details.
  - `uploadFile` PUTs to a presigned or local URL with the signed Content-Type, attaching the bearer only for
    `/api` routes.
  - `fetchJson` for result URLs.
- `src/lib/api/resources.ts`: one typed function per §4 endpoint. `src/lib/api/keys.ts`: a prefix-based query-key
  factory.
- Hooks:
  - `features/projects/api.ts`: all-projects paging for the dashboard; `useProject` **polls every 2 s while
    `building`**; routes; create/update/delete; routing jobs; rename; reassign.
  - `features/stores/api.ts`: infinite store list, pins, one store, details, and **optimistic progress**. That
    patches every cached list page, the detail and the pin colour, rolls back on error, and refetches pins and
    routes on settle.
  - `features/imports/api.ts`: `useStartImport` (create → upload → start); `useJob` polls every 1.5 s while
    queued/running; `useImportResult`.
  - `features/places/api.ts`: validate, maps config.
- Tests: `client.test.ts` (5), `stores/cache.test.ts` (3), `features/api.test.ts` (3).

**New dependency:** dev `openapi-typescript`, the generator F1 names.

**Verified:** `make backend-lint backend-test frontend-typecheck frontend-test` (210 backend, 13 frontend
passing). `npm run gen:api` against the live local API matches `make gen-api` byte for byte.

**Deviations:** the `ApiModel` base and the two new response models are backend changes made inside F1. Without
them the generated types would be loose (optional everywhere), or §3.4 would need a hand-written duplicate,
which rule 10 forbids.

**Open questions:** add a CI drift check (`make gen-api && git diff --exit-code`)? It needs Python and Node in one
job, so I have not changed `v2-ci.yml`.

## F3 · Dashboard

**Changed**
- `features/dashboard/DashboardPage.tsx`, a port of v1 `Dashboard.jsx`:
  - six KPI cards;
  - three Recharts charts (sites by installer, status breakdown, sites per project);
  - the KPI project-filter popover (search, select visible, all, clear);
  - all/ongoing/completed tabs;
  - project cards with progress, installers, PA/FA/partner and the four percentages;
  - routing status badges (`Routing…` / `Routing failed`, new);
  - card actions: open, append, edit, delete;
  - loading, empty and error-with-retry states.
  - It pages through `GET /projects` (limit 200) to aggregate across all projects, per the handoff.
- `features/dashboard/aggregate.ts`: the pure aggregation logic (totals, unique installers, breakdowns,
  completed rule, progress, search, filter toggling).
- `features/projects/ProjectDialogs.tsx`:
  - `EditProjectDialog`: react-hook-form + zod, sends `expected_version`, so a concurrent edit gets 409.
  - `DeleteProjectDialog`: v1's type-the-exact-name safeguard.
- `features/projects/schema.ts` / `ProjectMetaFields.tsx`: the metadata form schema and fields, shared with F4
  and F5.
- `lib/status.ts`: **one status palette from v1 `STATUS_MAP`** (route-planner.html: Upcoming `#d97706`, Other
  `#7c3aed`, …), used by chips, charts and pins. The F2 token guesses were corrected to it.
- `app/layout/HealthBadge.tsx`: v1's connection badge, now for API + DynamoDB.
- `features/imports/ImportWizard.tsx`: a **placeholder** the Add/Append buttons open. F4 replaces it.
- Test helpers: `src/test/render.tsx` (`renderWithProviders`, a `mockApi` fetch router), `fixtures.ts`,
  `schema.ts`. `setup.ts` gains `ResizeObserver` / pointer-capture stubs for Recharts and Radix in jsdom.
- Tests: `aggregate.test.ts` (5), `DashboardPage.test.tsx` (5: paging + KPIs + tabs, project filter, error and
  retry, delete gate with the confirm param, edit validation plus PATCH body with `expected_version`).

**New dependencies**
- `recharts` (+ its `react-is` peer): the charts, as in v1 and PLAN.
- `react-hook-form`, `zod`, `@hookform/resolvers`: the PLAN Part 3 form stack, reused by F4, F5 and F7.

**Verified**
- `make backend-lint backend-test frontend-typecheck frontend-test` (23 frontend tests) and `make
  frontend-build`.
- **Visual check in a browser: skipped.** The Claude-in-Chrome extension was not connected. The Vite dev server
  ran against the local API (`/api/health` proxied OK), but I could not screenshot. Please give the dashboard a
  quick look.

**Deviations**
- "Upcoming" uses the planner's `#d97706`, not the v1 dashboard's `#ca8a04`, so the dashboard and map agree.
- No read-only cards: the legacy external project is out of scope (§8).

## F5 · Project shell + Settings

**Changed**
- `features/projects/ProjectPage.tsx`:
  - Header: name, type, PA, store/installer counts, stops per day.
  - Tabs as before.
  - Loading state, and a clear "This project does not exist" for 404.
  - The project goes to tabs via outlet context (`useProjectContext`), so they don't refetch it.
- `features/projects/RoutingBanner.tsx`:
  - **Building:** info banner. `useProject` (F1) polls every 2 s while `building`, so the banner clears itself.
  - **Failed:** alert with a **Rebuild routes** action (recluster job).
- `features/settings/`:
  - `DetailsSection`: shared metadata fields plus `stops_per_day` (1–50, zod), saved with `expected_version`.
  - `InstallersSection`: add (a routing job; duplicate/blank blocked client-side) and inline rename (sync). Both
    are disabled while a build runs, matching the backend's 409.
  - `SchemaEditor`: add/remove/reorder fields; label, type, required, and options for select. **Keys of saved
    fields are locked**, since renaming would orphan stored values. A new field's key derives from its label,
    unique, never a reserved core name. Removing a saved field warns that its values become hidden, not deleted.
    Save is disabled while invalid or unchanged.
- `lib/validation/fields.ts`: client mirror of B1 (`fieldError`, `coreError`, `schemaErrors` = `validate_schema`,
  `keyFromLabel`, `moveItem`). It shares the same regexes and messages as `domain/schema.py`; F7 reuses it.
- `ProjectMetaFields` is now generic over the form type, so Settings can extend it without casts. Forms use
  `noValidate`, so the zod messages are the only validation messages (native `max=` was silently blocking
  submit).
- `app/router.tsx`: Stores/Routes/Settings are **lazy-loaded chunks**.
- Tests: `fields.test.ts` (5: every B1 rule, schema rules, key derivation, move) and `SettingsTab.test.tsx` (7:
  building banner, failed→rebuild posts recluster, 404, cap validation + PATCH body, installer add/duplicate/
  rename, paused while building, a full schema-editor round trip including derived key, select-needs-options,
  required, remove warning, reorder, and the exact PATCH payload).

**Verified:** `make backend-lint backend-test frontend-typecheck frontend-test` (35 frontend tests) and `make
frontend-build`. The visual browser check was skipped (Chrome extension not connected).

**Deviations**
- The generated `FieldDef-Input` type marks `type` and `required` as required, so the client always sends both;
  the backend accepts it either way.

**Open questions**
- The main bundle is ~1.07 MB (≈323 kB gzip), mostly Recharts on the landing dashboard. Lazy-loading the chart
  row would roughly halve first load. Worth doing now, or at cutover?

## F6 · MapView

**Changed**
- `components/map/MapView.tsx`, on `@vis.gl/react-google-maps` + `@googlemaps/markerclusterer`:
  - The key comes from `GET /config/maps`.
  - Status-coloured pins use **v1's SVG pin with the stack count in its head**.
  - Same-location records share one pin (mixed statuses show as "Other", as in v1), and clicking a stack opens
    an info window listing every record with installer, day and status; each row selects that store.
  - Legend toggles with counts. Turning off the last visible status brings all back, as in v1.
  - A meta line: records · pins · stacked records.
  - **Fit to bounds** only when the set of locations changes (one location → zoom 13, as in v1), never on
    selection or hover.
  - **Clustering at zoom ≤ 11** (`SuperClusterAlgorithm({maxZoom: 11})`); every location is its own pin closer
    in.
  - Props: `pins`, controlled `selectedId` / `hoveredId` (restyle and raise the marker; pan to the selected one
    if it is off-screen), `onSelect(uid)`, and `onBoundsChange(bounds)` for "only stores in view".
  - Without a browser key the map area shows a clear message, while the legend and counts still work.
- `components/map/pins.ts`, pure and tested: `groupPins`, `locationKey`, `filterByStatus`, `statusCounts`,
  `toggleStatus`, `boundsOf`, `inBounds` (antimeridian-safe), `markerSvg`.
- `tsconfig.app.json` loads `google.maps` types.
- Tests: `pins.test.ts` (5), `MapView.test.tsx` (2: the no-key message with legend/counts, and v1 toggle
  semantics through the UI).

**New dependencies:** `@vis.gl/react-google-maps` and `@googlemaps/markerclusterer` (the libraries PLAN/F6 name),
plus dev `@types/google.maps`.

**Verified:** `make backend-lint backend-test frontend-typecheck frontend-test` (42 frontend tests) and `make
frontend-build`. **Not verified against real Google Maps.** There is no browser key locally, and the Chrome
extension was unavailable, so pins, clustering and fit-bounds are untested on a live map. The grouping, colour
and bounds logic is unit-tested.

**Deviations**
- Stacking groups by coordinates rounded to 6 places. v1 used coordinates plus the address string, but `Pin`
  (§4) has no address, and records at one address share one geocode, so the groups are the same in practice.
- Markers are classic `google.maps.Marker`. `AdvancedMarkerElement` needs a Map ID from Google Cloud, which this
  project doesn't have yet.

**Open questions**
1. Is a Map ID available? It allows `AdvancedMarkerElement`; `Marker` is deprecated but still supported.
2. Is the cluster threshold (zoom ≤ 11) right for your densest projects?

## F4 · Import wizard + append flow

**Changed**
- `features/imports/ImportWizard.tsx` replaces the F3 placeholder.
  - **New project:** details → upload → review → mapping → `POST /projects` → navigate to the project's Stores
    tab, where the routing banner shows. **Append:** upload → review → mapping → `stores/append` → summary.
  - It remounts on every open, so state never leaks between imports.
- Steps:
  - `DetailsStep`: shared metadata fields plus stops per day and installer chips. The installer error now shows
    *together with* the form errors.
  - `UploadStep`: file picker / drop zone, then `useStartImport` (create job → presigned or local PUT with the
    signed Content-Type → start). **Real job progress** comes from polling `GET /jobs/{id}` (message + %), with
    the failure message and retry. PA prefills from the sheet's `pa_names` when empty.
  - `ReviewStep`:
    - status chips that filter (all / valid / need review / invalid / to fix);
    - editable store name (now **required**, as in B1) and address, re-validated **on blur** via
      `/places/validate`, as in v1;
    - a suggestion picker that validates the pick;
    - per-row exclude, and "exclude every row that still needs fixing";
    - 100 rows per page.
  - `MappingStep`:
    - every extra column with sample values, mapped to an existing field (auto-matched by key, label or
      `source_column`), **"Add as a new field"**, or ignore;
    - duplicate-target and required-field checks;
    - a preview of values the server would reject, with an opt-in "import with those values blank".
  - Append: when new fields were added, it first PATCHes the project's `field_schema` with `expected_version`,
    then appends, then lists `skipped` duplicates.
- `features/imports/model.ts`: all of the above as pure functions (review rows, `applyGeocode`, `rowProblems`,
  filters/summary, `normalizeColumn` = backend's, `autoMap`, `newFieldTarget`, `mappingErrors`,
  `extendedSchema`, `mappedValueProblems`, `buildStops`). Only verified rows (valid + coordinates), as in v1.
- **Backend, new endpoint `GET /config/field-schema`:** the default schema for a not-yet-created project, so the
  wizard maps against the backend's own `DEFAULT_FIELD_SCHEMA` rather than a frontend copy. Tested; types
  regenerated.
- **UX bug found by the tests and fixed:** with the "to fix" filter active, a row disappeared (unmounting its
  input) on the first keystroke that made it valid. Review filters are now a snapshot taken when chosen.
- Tests: `model.test.ts` (5), `ImportWizard.test.tsx` (2 end-to-end flows through the mocked API: validation,
  upload request shape, polling, store-name fix, suggestion re-validate, auto and new-field mapping, the exact
  `POST /projects` and append payloads, PATCH-before-append ordering, the skipped summary).

**Verified**
- `make backend-lint backend-test frontend-typecheck frontend-test` (211 backend, 49 frontend passing).
- Live: `GET /api/config/field-schema` through the Vite proxy.
- **Not verified end to end against the real stack.** Without a Google key every row comes back
  `needs_review`/0, so the review step can't make rows valid locally. The flow is covered by the mocked
  component tests, and the backend half was verified in B5/B6.

**Deviations**
- v1 had three steps; v2 adds **mapping** as a fourth, per the handoff. The other three run in v1's order.
- New project fields from the sheet are typed `text`. Change the type in Settings afterwards.

**Open questions:** none.

## F7 · Stores tab

**Changed**
- `features/stores/StoresTab.tsx`: toolbar, then **table left and map right** (stacked below `lg`), both driven by
  the same filters; the store drawer.
- `features/stores/StoresToolbar.tsx`:
  - debounced search (250 ms) → `q`;
  - status chips → `status=…`;
  - installer multi-select, including **Unassigned** (`installer=`);
  - "only stores in map view";
  - clear;
  - a **CSV** link to `export.csv` with the current filters and sort.
- `features/stores/StoresTable.tsx`:
  - **TanStack Table + Virtual**, with core columns then one column per schema field.
  - Header clicks map to the list endpoint's `sort`/`dir`; only the columns the API can sort are sortable.
  - The next page auto-loads near the end.
  - Inline editing (`EditableCell`) for store name and every schema field, with B1's rules checked client-side
    first. Address edits open the drawer, because they need geocode feedback.
  - Per-row status select (**optimistic**, rolled back on error).
  - A `route_stale` marker.
  - Row hover highlights the pin, and a pin click selects and scrolls to the row and opens the drawer.
- `features/stores/StoreDrawer.tsx` (sheet):
  - **Progress:** status, completed-by with installer suggestions, additional task, comment. Each saves on change
    or blur through the progress endpoint, optimistically.
  - **Details:** name, address parts and typed schema inputs, validated client-side. Only changed keys are sent,
    so an untouched address is never re-geocoded.
  - On a 422 it shows Google's message and **suggestions**; picking one validates it via `/places/validate` and
    fills addr/city/state/zip.
- "Only stores in view": the map reports bounds, then the tab loads the remaining pages and filters loaded rows
  with `inBounds`.
- `stores/ui.ts` (Zustand): UI state only (filters, sort, selection, hover, drawer, bounds), reset when the
  project changes. `features/stores/details.ts`: the pure details model (form ↔ stop, validation, minimal patch).
- Test harness: `mockApi` now awaits async handlers. The F7 tests use a small stateful fake, so refetches see
  writes.
- Tests: `ui.test.ts` (1), `details.test.ts` (3), `StoresTab.test.tsx` (5):
  - filters, search, sort and CSV URL reach the API; schema columns render; the map degrades without a key;
  - inline edit with B1 validation and a minimal PATCH;
  - **optimistic status with rollback on a 500**;
  - drawer address 422 → suggestion → fields filled;
  - drawer progress writes are progress-only (no details PATCH).

**New dependencies:** `@tanstack/react-table` and `@tanstack/react-virtual`, the table stack PLAN/F7 name.

**Verified:** `make backend-lint backend-test frontend-typecheck frontend-test` (211 backend, 58 frontend passing)
and `make frontend-build`. The Stores tab is its own 197 kB chunk. **Not verified in a browser** (Chrome extension
unavailable) and not with a live map (no browser key).

**Deviations**
- City, state and ZIP columns aren't sortable: the §4.3 sort list doesn't include them.
- "Only in view" filters the loaded rows client-side after loading every page (≤ ~1000 stops). The server has no
  bounds filter, and §8 keeps list filtering in the service.
- Tests stub `clientWidth`/`clientHeight` (file-local) so the virtualizer renders rows in jsdom.

**Open questions:** none.

## R1 · Routes tab port

**Changed**
- `features/routes/routeModel.ts`: a pure, faithful port of the legacy planner logic, keyed by uid.
  - `mapsUrlForStops` / `routeChunks` (10 stops per link; each chunk starts at the previous destination);
    `routableStops` (Complete leaves the route).
  - `territoryTag` ("North Atlanta", "Southwest Macon"… relative to the dominant city's centroid, same
    thresholds as v1).
  - Day helpers: `tally`, `uniqueCities`, `dayStateLabel` (US state names), `sameAddressRecords`.
  - `installerSummary` (v1 section header: active days, ~active stops/day).
  - Filters: day list `"1, 3 5"`, PA (multi-value `fields.pa`), DMA, venue type, state (canonical code), city
    (title-cased), and search over name/address/ZIP/fields/comment/status label. `filterOptions` feeds the
    dropdowns.
  - CSV: `dayCsvRows` / `allCsvRows` / `toCsv`, with the same formula guard as the server export.
- `features/routes/RoutesTab.tsx`:
  - Installer tabs: colour, territory tag, and stats badge from the bundle (stops · days · miles), plus "All
    installers".
  - Day-cards / summary toggle and the filter row.
  - Expand/collapse all.
  - **Rebalance upcoming** and **Rebuild all routes**, each a job behind an in-app confirmation. They are
    disabled while building, and the project banner (F5) shows progress.
  - All-routes CSV of the current filters.
  - The shared **MapView** with the filtered route pins; a pin click opens the store.
  - **The bundle refetches when `routing_status` leaves `building`**, so a finished job shows by itself.
- `features/routes/DayCard.tsx`:
  - Header: day N of total, state label, status counts, active/records, same-address count, an addresses
    dialog, collapse.
  - Cities strip.
  - Ordered stops: name, address, ID/PA/venue code, "by" installer name, an optimistic status select, an
    **installer select that reassigns after a confirmation** (sync endpoint), an additional-task badge, the
    comment, and **edit → the Stores drawer** (progress incl. installer name, additional task and comment, plus
    details).
  - Actions: Maps route link(s), chunked like v1, or "Route complete"; copy addresses (v1 text format); per-day
    CSV.
- `features/routes/SummaryTable.tsx`: v1's summary view.
- `components/ConfirmDialog.tsx` (never `window.confirm`), `lib/download.ts`.
- Tests: `routeModel.test.ts` (10), `RoutesTab.test.tsx` (7):
  - tabs with stats and territory, the day card, the Maps link;
  - installer/day/search filters and the summary view;
  - **reassign only after confirm** (cancel sends nothing);
  - rebalance job after confirm;
  - disabled while building;
  - all-routes CSV content and copy-addresses text;
  - drawer from a stop.

**Verified:** `make backend-lint backend-test frontend-typecheck frontend-test` (211 backend, 75 frontend passing)
and `make frontend-build`. The bundle endpoint was already verified on DynamoDB Local in B6/B8. **Not verified in a
browser** (Chrome extension unavailable).

**Deviations from the legacy page**
- **CSV columns follow the project schema.** v1 hard-coded PA/Venue Type/DMA/Venue Code/Brand/Assigned Region;
  v2 emits the schema's fields by label, and migrated projects keep `brand` as a schema field (B12). "ARA Modem
  Collected" is gone with the legacy external project.
- **Add/rename installer** live in Settings (F5) instead of on the tab strip. The tab strip stays a view control.
- "Rebalance" and "rebuild" are separate buttons with their own explanations. v1 exposed rebalance on the page
  and recluster only through the API.
- Inline per-field editing on the card (store name, brand…) moved to the shared drawer, so Stores and Routes edit
  through one validated form.

**Open questions:** none.

## R2 · Remove the iframe path

**Changed**
- Confirmed nothing in v2 loads the legacy page. There is no `<iframe>`, no route to it, and nothing under
  `frontend/public` besides the favicon.
- Three source comments that named `route-planner.html` as the port's origin now say "the v1 legacy route
  planner", so they don't dangle once the v1 file is deleted at cutover.
- `src/legacy-guard.test.ts`: fails if any frontend source references `route-planner.html` or renders an
  `<iframe>`, so the path can't return quietly.
- Docs left as they are, on purpose:
  - PLAN.md's context paragraph (describes v1);
  - AGENT-HANDOFF's R1/R2 task text (the work order);
  - REVIEW-NOTES, which cite the file as the source of ported behaviour.
- CHECKLIST: "Legacy planner page and iframe removed" is ticked for v2. "Contract tests cover every endpoint"
  is ticked after checking all 25 OpenAPI paths against the `TestClient` tests.

**Verified:** `make backend-lint backend-test frontend-typecheck frontend-test` (211 backend, 77 frontend passing).

---

## Summary for the reviewer

**Commits (on `tech-stack-migration`):**
- Baseline `35f48b3`.
- Phase 2: B1, B2, B3, B11, B4, B5, B6, B7, B9, B10, B8, B12. **B13 skipped** (no AWS credentials).
- Phase 3: F2, F1, F3, F5, F6, F4, F7.
- Phase 4: R1, R2.

**Tests:** backend 49 → **211**, frontend 1 → **77**, all passing at every commit.

**Bugs found and fixed outside a task's own scope**

| Where | Bug | Fix |
|-------|-----|-----|
| `config.py` (B11) | `resolve_google_server_key` was `lru_cache`'d on an unhashable `Settings` → `TypeError` | Cache moved onto the SSM fetch, keyed on strings |
| `files.py` (B4) | S3 presigned URLs came out as **SigV2**; buckets created since 2020 reject them, so browser uploads would fail in AWS | Client forced to SigV4 with virtual-hosted addressing; test asserts it |
| v1 data (B12) | The v1 dashboard joined progress on the Python-format key while the page saved JS-format keys, so progress for stops with integral or null coordinates never counted | The migration joins on both; the parity report flags the differences |
| Review step (F4) | Under an active filter, a row unmounted mid-typing once it became valid | Filters are snapshots |

**Questions to decide (collected from the sections above)**

1. **B11 / B13:** how to give `ApiStack` the Google **browser** key (`DT_GOOGLE_BROWSER_KEY`): plain env var
   from context, or a second SSM parameter? Also: S3 CORS falls back to `*` when `cors_origins` is empty.
2. **B3:** keep `LambdaInvoker` (boto3) in `services/`, as the handoff placed it, or move it to `repositories/`
   or `adapters/`?
3. **B5:** Google cost: skip the Places call when geocoding fails or is partial? And should an import fail fast
   when no server key is configured, instead of succeeding with every row in review?
4. **B6:** `stop_count` is maintained on create/append only (there is no stop delete). Is that fine as an
   informational field?
5. **B7:** without a Google key locally, no address can be edited (always 422). Is that fine for dev?
6. **B9:** schema edits don't rewrite stored data. Removed fields' values are hidden, not deleted, and a newly
   required field doesn't re-validate existing stops. Accept, or require confirmation?
7. **B12:** the real parity run needs a prod Mongo dump (Phase 5).
8. **F1:** add a CI drift check, `make gen-api && git diff --exit-code`?
9. **F5:** lazy-load the dashboard charts to shrink the ~1.1 MB main bundle?
10. **F6:** is a Google Map ID available (`AdvancedMarkerElement`)? Is clustering at zoom ≤ 11 right?

**Not verified here:** anything needing AWS (B13), a Google key (real geocoding, the live map), or a browser (the
Chrome extension was not connected). Those paths are covered by unit and component tests with fakes and mocks,
and the backend flows were exercised end to end on DynamoDB Local.

---

# Round 2

Work order: `AGENT-HANDOFF.md` §9–§11 and `STORE-MODEL.md`. Same process as round 1: one commit per task on
`tech-stack-migration`, all four gates green before each commit. Baseline commit `2023536` holds the round-2
docs unchanged.

## Y1 · Job runners idempotent on redelivery

**Changed**
- `RoutingService.run_build` and `ImportService.run` return early (with an info log) when the job is already
  `succeeded` or `failed`. Before, a redelivered routing event flipped SUCCEEDED → RUNNING → FAILED
  ("superseded"), and a redelivered import re-ran every geocode.
- A redelivery while the first run is still `running` is not guarded: the fence (§3.2) already makes the loser
  stop as superseded for routing, and a duplicate import run writes the same result file. Guarding that would
  need a conditional `queued → running` claim; noted as an option, not done.

**Tests:** same event twice for routing (after success, after failure) and for imports; status history stays
`[queued, running, succeeded]` / `[queued, running, failed]`, and the import geocodes once.

**Verified:** gates green (214 backend, 77 frontend).

---

## Y2 · Wrong-shape cursor → 400

**Changed**
- `decode_cursor` raises `ValueError` unless the decoded JSON is an object.
- `offset_from_cursor` (new, in `repositories/dynamo.py` until Y10 moves it) is the one place that reads
  `{"offset": n}` cursors; it rejects non-int, bool and negative offsets. `StoreService.list` and the in-memory
  fakes use it.
- `query_page(table, kwargs, cursor, key_attributes)` checks that a decoded start key has exactly the query's key
  attributes (`PK, SK` for stops; plus `GSI1PK, GSI1SK` for the project list) with string values before it
  reaches DynamoDB. A botocore `ValidationException` on a query that had a start key is also mapped to
  `ValueError`, as the handoff asked.
- **Deviation:** the shape check was added on top of the handoff's "translate `ValidationException`". moto does
  not raise `ValidationException` for a bad start key (it crashes with a `TypeError`), so the mapping alone could
  not be tested; the explicit check is testable and behaves the same against real DynamoDB.

**Tests:** base64 of `[1]`, `"str"`, `5`, and bad offsets → 400 on `/projects` and `/projects/{id}/stores`;
`decode_cursor`/`offset_from_cursor` unit tests; moto: wrong-shape start keys on both Dynamo list methods raise
`ValueError`.

**Verified:** gates green (218 backend, 77 frontend).

---

## Y3 · Unlisted-installer stops visible; reassign 404; migration derives installers

**Changed**
- `services/routing.py` `route_installers(installers, stops)`: the project's list, then (sorted) any other
  installer a stop is routed to. `routes()` groups and computes stats over it, and `RoutesBundle.installers`
  returns it, so the Routes tab shows a card for the stray installer instead of hiding its stops.
- `reassign` builds the optimizer layout over the same union, so a stop on an unlisted installer can be moved
  off it. The optimizer's `LookupError("Stop not found")` becomes `NotFoundError` (404). The reassign *target*
  must still be in `project.installers` (422 as before), and the reassign dropdown still lists only those.
- `domain/migration.py`: when a v1 doc has no installers, the list is rebuilt from the stops (order of first
  appearance), as v1 did. The parity report gains "installers derived from stops" and
  "stops on unlisted installer: N" lines.
- Not changed: rebalance/recluster still plan over `project.installers` only. Recluster reassigns every stop, so
  it clears strays; rebalance keeps non-pending strays where they are.

**Tests:** `/routes` with a stop on `Ghost` (card present, totals add up); reassign off `Ghost`; optimizer
`LookupError` → `NotFoundError` with the slot released; migration with an empty and a partial installers list.

**Verified:** gates green (223 backend, 77 frontend).

---

## Y4 · DT_AWS_REGION wired for Lambda

**Changed**
- `config.py`: `aws_region` reads `DT_AWS_REGION`, then the Lambda runtime's `AWS_REGION`, then defaults to
  `us-east-1` (`AliasChoices`; `populate_by_name` keeps `Settings(aws_region=...)` working in tests).
- `infra/stacks/api_stack.py`: `common_env` sets `DT_AWS_REGION` to the stack's region, so both Lambdas get it
  explicitly.

**Tests:** `tests/test_config.py`: default, runtime fallback, `DT_` precedence, init by field name.

**Verified:** gates green (227 backend, 77 frontend). `cdk synth -c env=dev` (output to a scratch dir, not
`infra/cdk.out`): `DT_AWS_REGION` is set on the Api and Worker functions.

---

## X1 · Map fits bounds only when locations change

**Changed** (`components/map/MapView.tsx`, `components/map/pins.ts`)
- Markers are keyed by location key. They are rebuilt only when `locationSignature(visible groups)` changes
  (keys only: no status, no count).
- The fit is its own effect, keyed on `locationSignature` over **all** pins (before the legend filter). It runs
  when the project's set of locations changes (first load, import, address edit that moves a pin), never on an
  optimistic recolour, a legend toggle, a hover or a selection.
- Styling is a third effect: `markerStyles(groups, selectedId, hoveredId)` gives each location its
  `{status, count, emphasis}`; `changedStyles(previous, next)` lists the keys that differ, and only those markers
  get `setIcon` / `setZIndex` / `setTitle`. This also covers **X7(a)**: a row hover now restyles two markers
  (the old and the new one) instead of every marker.
- Click handlers and the stack InfoWindow read the current group through a ref, so a recoloured stack shows its
  new statuses without a rebuild.
- Pan-to-selection runs only when `selectedId` changes.

**Tests:** `pins.test.ts`: the signature ignores status and changes on a move; style diffs on first paint, hover
A → hover B (exactly the two keys), selection, recolour of one stop; z-index ordering. The effects themselves
need a Google Maps mock; not added (the helpers carry the logic).

**Verified:** gates green (227 backend, 80 frontend). No browser check (no browser key; Chrome extension not
connected in round 1 either).

---

## X2 · Stores tab refreshes when a routing build finishes

**Changed**
- `features/projects/api.ts` `useRefreshWhenRoutingFinishes(project)`: when `routing_status` leaves `building`,
  invalidate `keys.project(id)`, which covers the stores list, pins, the open store, routes and the project
  itself. `ProjectPage` calls it, so it runs whichever tab is open.
- Removed the Routes-tab-only effect, which invalidated `keys.routes` alone.

**Tests:** `StoresTab.test.tsx`: the project polls `building` → `ready` while Stores is open; the list refetches
and the new installer shows. Confirmed the test fails with the hook call removed.

**Verified:** gates green (227 backend, 81 frontend).

---

## X3 · Day-card status select optimistic

**Changed**
- `features/stores/cache.ts` `patchStopInRoutes(bundle, uid, patch)`: copy of the bundle with one stop patched;
  other installers and days keep their identity.
- `useUpdateProgress.onMutate` also cancels `keys.routes(id)`, snapshots the cached bundle and patches it;
  `onError` restores it. The existing `onSettled` refetch of the bundle stays.

**Tests:** `RoutesTab.test.tsx`: a DayCard status change shows the new value while the PATCH is pending and
reverts when it fails (fails without the fix). `cache.test.ts`: `patchStopInRoutes` identity and no-op cases.

**Verified:** gates green (227 backend, 84 frontend).
