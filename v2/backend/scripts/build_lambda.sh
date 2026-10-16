#!/usr/bin/env bash
# Build the Lambda deployment directory (arm64, Python 3.12) consumed by infra/stacks/api_stack.py.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=build/package
rm -rf build
mkdir -p "$OUT"
PIP="python3 -m pip"
if [ -x .venv/bin/python ]; then PIP=".venv/bin/python -m pip"; fi
$PIP install --quiet --upgrade --target "$OUT" \
  --platform manylinux2014_aarch64 --implementation cp --python-version 3.12 --only-binary=:all: \
  -r requirements-lambda.txt
cp -R src/dolphin_tracker "$OUT/"
find "$OUT" -type d -name '__pycache__' -prune -exec rm -rf {} +
find "$OUT" -type d -name 'tests' -path '*/site-packages/*' -prune -exec rm -rf {} + 2>/dev/null || true
echo "Lambda package built at $OUT ($(du -sh "$OUT" | cut -f1))"
