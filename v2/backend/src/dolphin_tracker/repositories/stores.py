"""Stop items (one per store, planning data + field progress). Implemented in Phase 2."""
from __future__ import annotations

from typing import Any, Protocol

from dolphin_tracker.domain.models import Page, Stop


class StoreRepository(Protocol):
    def put_many(self, project_id: str, stops: list[Stop]) -> None: ...
    def get(self, project_id: str, stop_uid: str) -> Stop | None: ...
    def list(self, project_id: str, *, limit: int = 50, cursor: str | None = None) -> Page[Stop]: ...
    def list_all(self, project_id: str) -> list[Stop]:
        """Whole-project read for routing builds, the map pins endpoint and the routes bundle."""
        ...
    def update_fields(self, project_id: str, stop_uid: str, changes: dict[str, Any]) -> Stop:
        """Partial update. Routing writes touch only installer/day/seq; progress writes never touch those."""
        ...
    def delete_all(self, project_id: str) -> int: ...


class DynamoStoreRepository:
    def __init__(self, table) -> None:
        self._table = table

    def put_many(self, project_id: str, stops: list[Stop]) -> None:
        raise NotImplementedError("Phase 2: batch_writer over Keys.stop(project_id, uid)")

    def get(self, project_id: str, stop_uid: str) -> Stop | None:
        raise NotImplementedError("Phase 2")

    def list(self, project_id: str, *, limit: int = 50, cursor: str | None = None) -> Page[Stop]:
        raise NotImplementedError("Phase 2: Query PK with begins_with(SK, 'STOP#') and a cursor")

    def list_all(self, project_id: str) -> list[Stop]:
        raise NotImplementedError("Phase 2: paginated Query loop")

    def update_fields(self, project_id: str, stop_uid: str, changes: dict[str, Any]) -> Stop:
        raise NotImplementedError("Phase 2: UpdateItem with attribute_exists(PK)")

    def delete_all(self, project_id: str) -> int:
        raise NotImplementedError("Phase 2: Query keys then batch delete")
