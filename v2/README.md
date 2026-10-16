# Dolphin Tracker v2

AWS re-platform of Dolphin Tracker plus the new store-level view. Design and status live in
[`docs/PLAN.md`](docs/PLAN.md) and [`docs/CHECKLIST.md`](docs/CHECKLIST.md). Implementation agents start from
[`docs/AGENT-HANDOFF.md`](docs/AGENT-HANDOFF.md). The v1 app at the
repo root stays untouched until cutover.

## Layout

```
v2/
  docs/       PLAN.md, CHECKLIST.md, later DETAILED-PLAN.md and ADRs
  infra/      CDK app (Python): DataStack, ApiStack, WebStack
  backend/    Python 3.12 Lambda code: routers → services → repositories, pure domain modules, tests
  frontend/   Vite + React 19 + TypeScript + Tailwind v4 + shadcn/ui
  Makefile    developer entry points (`make help`)
  docker-compose.yml  DynamoDB Local for development
```

## Prerequisites

- Python 3.12+ (Lambda runtime is 3.12; newer local versions are fine)
- Node 24. If it comes from nvm, the Makefile sources nvm itself; `frontend/.nvmrc` pins 24.
- Docker or Podman is optional. With either, `make ddb-up` runs DynamoDB Local with persistent data
  (Podman: run `podman machine start` first). Without containers,
  `make ddb-moto` runs moto's in-memory DynamoDB stand-in on the same port (data is lost on exit).
- AWS CLI with credentials for deploys; the CDK CLI runs through `npx`

## First run

```bash
cd v2
make setup            # venvs + npm install
make ddb-up           # local DynamoDB in Docker   (or: make ddb-moto   in its own terminal, no Docker)
make ddb-table        # create the table from DataStack in the local DynamoDB
make backend-dev      # API on http://localhost:8080  (OpenAPI at /api/docs)
make frontend-dev     # UI on http://localhost:5173, /api proxied to the backend
```

Tests and checks: `make backend-test backend-lint frontend-typecheck frontend-test`.

## Deploying

```bash
aws ssm put-parameter --name /dolphin-tracker/dev/google-maps-server-key --type SecureString --value '<key>'
make infra-synth ENV=dev
make infra-deploy ENV=dev
```

`build-lambda` produces `backend/build/package` for arm64 / Python 3.12; CDK ships that directory to
both Lambdas. `WebStack` uploads `frontend/dist` when it exists.

## Conventions

- Routers do HTTP only; services hold rules; repositories hold persistence. Pure domain code
  (`backend/src/dolphin_tracker/domain`) has no I/O.
- Every list endpoint is paginated with an opaque cursor. See `docs/PLAN.md` → API conventions.
- Environment variables for the backend are prefixed `DT_` (see `backend/src/dolphin_tracker/config.py`).
