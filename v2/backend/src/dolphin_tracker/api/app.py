"""FastAPI application factory. Routers do HTTP only; see docs/PLAN.md → Backend layering."""
from __future__ import annotations

from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.middleware.cors import CORSMiddleware

from dolphin_tracker import __version__
from dolphin_tracker.api.routers import health, jobs, places, projects, stores
from dolphin_tracker.config import Settings, get_settings
from dolphin_tracker.domain.errors import ConflictError, NotFoundError, ValidationFailed


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

    api = APIRouter(prefix="/api")

    @api.get("", tags=["health"])
    def root() -> dict[str, str]:
        return {"message": "Dolphin Tracker API", "version": __version__}

    api.include_router(health.router)
    api.include_router(places.router)
    api.include_router(projects.router)
    api.include_router(stores.router)
    api.include_router(jobs.router)
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

    @app.exception_handler(NotImplementedError)
    async def _not_implemented(_: Request, exc: NotImplementedError) -> JSONResponse:
        return JSONResponse(status_code=501, content={"detail": f"Not implemented yet: {exc}"})

    return app


app = create_app()
