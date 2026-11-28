"""Log Visit: find a store in any project to log a visit to."""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from dolphin_tracker.api.deps import get_visit_search_service
from dolphin_tracker.domain.visit_search import VisitSearchResult
from dolphin_tracker.services.visit_search import VisitSearchService

router = APIRouter(tags=["visits"])


@router.get("/visit-search", response_model=VisitSearchResult)
def search_for_a_visit(
    service: Annotated[VisitSearchService, Depends(get_visit_search_service)],
    q: Annotated[str, Query(max_length=200, description="A DD code or stick number (whole or part), or words of "
                                                        "the store's name, ExtID or address")] = "",
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
) -> VisitSearchResult:
    """Stores of every project matching `q`, best first: an exact DD code, then part of one, then the store's
    words. Fewer than two characters find nothing."""
    return service.search(q, limit=limit)
