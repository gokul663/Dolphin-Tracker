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
