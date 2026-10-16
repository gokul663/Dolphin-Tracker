from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(prefix="/jobs", tags=["jobs"])

# Phase 2: POST /imports (presigned upload URL + job id), GET /{job_id} (status, progress, result URL)
