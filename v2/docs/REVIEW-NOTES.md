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
