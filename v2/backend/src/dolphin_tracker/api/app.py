"""FastAPI application factory. Routers do HTTP only; see docs/PLAN.md → Backend layering."""
from __future__ import annotations

from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.middleware.cors import CORSMiddleware

from dolphin_tracker import __version__
from dolphin_tracker.api.auth import PrincipalDep, enforce
from dolphin_tracker.api.routers import (
    device_sync,
    health,
    jobs,
    lists,
    places,
    projects,
    route_plans,
    screen_sheet,
    stores,
    technician,
    visit_search,
    visits,
)
from dolphin_tracker.config import Settings, get_settings
from dolphin_tracker.domain.auth import Principal
from dolphin_tracker.domain.errors import ConflictError, NotFoundError, ValidationFailed
from dolphin_tracker.repositories.device_data import DeviceDataUnavailable


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    app = FastAPI(
        title="Dolphin Tracker API",
        version=__version__,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        redoc_url=None,
    )
    if settings.cors_origin_list:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origin_list,
            allow_credentials=False,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    # Every route under /api is checked against the caller's role (api/auth.py POLICY).
    api = APIRouter(prefix="/api", dependencies=[Depends(enforce)])

    @api.get("", tags=["health"])
    def root() -> dict[str, str]:
        return {"message": "Dolphin Tracker API", "version": __version__}

    @api.get("/me", tags=["auth"], response_model=Principal)
    def me(who: PrincipalDep) -> Principal:
        """Who is signed in, their role, and what it lets them do (the screens hide what it does not)."""
        return who

    api.include_router(health.router)
    api.include_router(places.router)
    api.include_router(projects.router)
    api.include_router(stores.router)
    api.include_router(jobs.router)
    api.include_router(lists.router)
    api.include_router(visits.router)
    api.include_router(visits.comments_router)
    api.include_router(visit_search.router)
    api.include_router(route_plans.router)
    api.include_router(device_sync.router)
    api.include_router(screen_sheet.router)
    api.include_router(technician.router)
    app.include_router(api)

    @app.exception_handler(NotFoundError)
    async def _not_found(_: Request, exc: NotFoundError) -> JSONResponse:
        return JSONResponse(status_code=404, content={"detail": str(exc)})

    @app.exception_handler(ConflictError)
    async def _conflict(_: Request, exc: ConflictError) -> JSONResponse:
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    @app.exception_handler(ValidationFailed)
    async def _unprocessable(_: Request, exc: ValidationFailed) -> JSONResponse:
        return JSONResponse(status_code=422, content={"detail": exc.detail})

    @app.exception_handler(DeviceDataUnavailable)
    async def _device_data_down(_: Request, exc: DeviceDataUnavailable) -> JSONResponse:
        return JSONResponse(status_code=503, content={"detail": str(exc)})

    @app.exception_handler(NotImplementedError)
    async def _not_implemented(_: Request, exc: NotImplementedError) -> JSONResponse:
        return JSONResponse(status_code=501, content={"detail": f"Not implemented yet: {exc}"})

    return app


app = create_app()
