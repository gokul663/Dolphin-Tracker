# Backend

Python 3.12 Lambda code for Dolphin Tracker v2. Layering (see `docs/PLAN.md`):

```
src/dolphin_tracker/
  domain/        pure functions and models, no I/O: route_optimizer (v1, unchanged), parsing, addresses
  repositories/  DynamoDB and S3 persistence; in-memory fakes for tests
  services/      use cases: projects, stores, routing, imports, geocoding
  api/           FastAPI app, dependency wiring, routers (HTTP only)
  handlers/      Lambda entry points: api (Mangum) and worker (async jobs)
tests/
scripts/         build_lambda.sh, create_local_table.py
```

Local: `make backend-setup backend-dev` from `v2/`. Env vars are prefixed `DT_` (see `config.py`).
