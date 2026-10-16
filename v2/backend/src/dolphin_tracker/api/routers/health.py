from __future__ import annotations

from collections.abc import Callable
from typing import Annotated

from fastapi import APIRouter, Depends

from dolphin_tracker.api.deps import SettingsDep, get_db_probe
from dolphin_tracker.domain.models import now_iso

router = APIRouter(tags=["health"])


@router.get("/health")
def health(settings: SettingsDep, probe: Annotated[Callable[[], bool], Depends(get_db_probe)]) -> dict:
    return {"status": "ok", "env": settings.app_env, "db": probe(), "ts": now_iso()}
