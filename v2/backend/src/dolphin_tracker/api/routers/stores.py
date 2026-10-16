from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(prefix="/projects/{project_id}/stores", tags=["stores"])

# Phase 2: GET "" (paginated, filters, search), GET /pins (whole project, light),
# GET /{uid}, PATCH /{uid} (details; geocode on address change), PATCH /{uid}/progress, GET /export.csv
