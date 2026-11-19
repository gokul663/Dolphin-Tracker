from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from dolphin_tracker.api.deps import get_screen_sheet_service
from dolphin_tracker.api.schemas import ScreenSheetUpload
from dolphin_tracker.services.screen_sheet import ScreenSheetResult, ScreenSheetService

router = APIRouter(prefix="/projects/{project_id}/screen-sheet", tags=["screen-sheet"])
ServiceDep = Annotated[ScreenSheetService, Depends(get_screen_sheet_service)]


@router.post("", response_model=ScreenSheetResult)
def read_screen_sheet(project_id: str, body: ScreenSheetUpload, service: ServiceDep) -> ScreenSheetResult:
    """Line a screen cost sheet (DD code, screen size, screen count, cost) up with the project's screens. Without
    `apply` nothing is written: the result is the preview. With it, sizes and owners that differ are saved."""
    return service.run(project_id, body.filename, body.content_base64, apply=body.apply)
