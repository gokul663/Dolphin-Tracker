from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from dolphin_tracker.api.auth import PrincipalDep
from dolphin_tracker.api.deps import get_technician_service
from dolphin_tracker.domain.lists import NameEntry
from dolphin_tracker.services.technician import MyProfileUpdate, MyRoute, TechnicianService

router = APIRouter(prefix="/my", tags=["technician"])

ServiceDep = Annotated[TechnicianService, Depends(get_technician_service)]


@router.get("/route", response_model=MyRoute)
def my_route(service: ServiceDep, who: PrincipalDep) -> MyRoute:
    """The signed-in technician's own days in every active plan, and who they are on the Installers page."""
    return service.route(who)


@router.put("/profile", response_model=NameEntry)
def update_my_profile(body: MyProfileUpdate, service: ServiceDep, who: PrincipalDep) -> NameEntry:
    """Their additional phone and shipping address; nothing else of the entry."""
    return service.update_profile(who, body)
