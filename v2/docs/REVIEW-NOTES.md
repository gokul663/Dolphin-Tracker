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
