# Dolphin Tracker v2 — developer entry points. Run from v2/.
SHELL := /bin/bash
PY ?= python3
BACKEND := backend
INFRA := infra
FRONTEND := frontend
CDK ?= npx --yes aws-cdk@2
# Make runs a non-interactive bash, so nvm is not loaded. Source it when present; CI has node on PATH already.
NODE_SETUP = if [ -s "$$HOME/.nvm/nvm.sh" ]; then . "$$HOME/.nvm/nvm.sh" && nvm use --silent >/dev/null 2>&1 || true; fi
ENV ?= dev
# Container runtime for DynamoDB Local: docker, or podman (`podman compose` drives the same compose file).
COMPOSE ?= $(shell command -v docker >/dev/null 2>&1 && echo "docker compose" || (command -v podman >/dev/null 2>&1 && echo "podman compose"))
# DynamoDB Local accepts any credentials but boto3 insists on having some.
LOCAL_AWS := AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local AWS_DEFAULT_REGION=us-east-1 DT_DYNAMODB_ENDPOINT_URL=http://localhost:8000

.PHONY: help setup backend-setup infra-setup frontend-setup ddb-moto \
        backend-dev backend-test backend-lint build-lambda \
        frontend-dev frontend-build frontend-test frontend-typecheck \
        infra-synth infra-diff infra-deploy ddb-up ddb-down ddb-table

help:
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-18s %s\n", $$1, $$2}'

setup: backend-setup infra-setup frontend-setup ## Install everything for local development

backend-setup: ## Create backend venv and install with dev extras
	cd $(BACKEND) && $(PY) -m venv .venv && .venv/bin/pip install -q --upgrade pip && .venv/bin/pip install -q -e '.[dev]'

infra-setup: ## Create infra venv and install CDK libraries
	cd $(INFRA) && $(PY) -m venv .venv && .venv/bin/pip install -q --upgrade pip && .venv/bin/pip install -q -r requirements.txt

frontend-setup: ## Install frontend dependencies
	cd $(FRONTEND) && $(NODE_SETUP); npm install

backend-dev: ## Run the API on :8080 against DynamoDB Local; jobs run inline, files in backend/.local-files
	cd $(BACKEND) && $(LOCAL_AWS) DT_WORKER_MODE=$${DT_WORKER_MODE:-inline} .venv/bin/uvicorn dolphin_tracker.api.app:app --reload --port 8080

backend-test: ## Run backend tests
	cd $(BACKEND) && .venv/bin/pytest -q

backend-lint: ## Lint backend with ruff
	cd $(BACKEND) && .venv/bin/ruff check src tests

build-lambda: ## Build the Lambda deployment package into backend/build/package (arm64, py3.12)
	cd $(BACKEND) && ./scripts/build_lambda.sh

frontend-dev: ## Run Vite dev server on :5173 (proxies /api to :8080)
	cd $(FRONTEND) && $(NODE_SETUP); npm run dev

frontend-build: ## Production build of the frontend
	cd $(FRONTEND) && $(NODE_SETUP); npm run build

frontend-test: ## Run frontend unit tests
	cd $(FRONTEND) && $(NODE_SETUP); npm test -- --run

frontend-typecheck: ## Type-check the frontend
	cd $(FRONTEND) && $(NODE_SETUP); npm run typecheck

infra-synth: build-lambda ## Synthesize CloudFormation for ENV (default dev)
	cd $(INFRA) && $(NODE_SETUP); source .venv/bin/activate && $(CDK) synth -c env=$(ENV)

infra-diff: build-lambda ## Diff against the deployed ENV
	cd $(INFRA) && $(NODE_SETUP); source .venv/bin/activate && $(CDK) diff -c env=$(ENV)

infra-deploy: build-lambda frontend-build ## Deploy all stacks for ENV
	cd $(INFRA) && $(NODE_SETUP); source .venv/bin/activate && $(CDK) deploy --all -c env=$(ENV)

ddb-up: ## Start DynamoDB Local via docker or podman (persistent). Without either use `make ddb-moto`.
	@[ -n "$(COMPOSE)" ] || { echo "Neither docker nor podman found. Install one, or run 'make ddb-moto' (no containers, in-memory)."; exit 1; }
	$(COMPOSE) up -d

ddb-moto: ## Start an in-memory DynamoDB stand-in on :8000 via moto_server (foreground; data is lost on exit)
	@echo "moto_server on http://localhost:8000 (Ctrl-C to stop). In another terminal: make ddb-table backend-dev"
	cd $(BACKEND) && .venv/bin/moto_server -p 8000 -H 127.0.0.1

ddb-down: ## Stop DynamoDB Local
	$(COMPOSE) down

ddb-table: ## Create the local table matching DataStack
	cd $(BACKEND) && $(LOCAL_AWS) .venv/bin/python scripts/create_local_table.py
