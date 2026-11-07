"""Route plan items (ROUTE-PLANNER §7): `ROUTEPLAN#<id>` / `META` (listed through GSI1 by status, newest first)
and one `STOP#<project_id>#<stop_uid>` item per store in the plan."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import Any, Protocol

from botocore.exceptions import ClientError

from dolphin_tracker.domain.cursors import encode_cursor
from dolphin_tracker.domain.errors import ConflictError, NotFoundError
from dolphin_tracker.domain.models import Page, now_iso
from dolphin_tracker.domain.route_plans import PlanStatus, PlanStop, RoutePlan
from dolphin_tracker.repositories.dynamo import (
    GSI1,
    GSI1_KEY,
    Keys,
    build_set_expression,
    from_ddb,
    query_page,
    strip_internal,
    to_ddb,
)

WRITE_WORKERS = 16
ASSIGNMENT_FIELDS = frozenset({"installer", "day", "seq", "drive_minutes"})
PlanStopChange = tuple[str, dict[str, Any]]  # plan stop key, {installer?, day?, seq?, drive_minutes?}


class RoutePlanRepository(Protocol):
    def put(self, plan: RoutePlan) -> None: ...
    def get(self, plan_id: str) -> RoutePlan | None: ...
    def list(self, status: PlanStatus, *, limit: int = 50, cursor: str | None = None) -> Page[RoutePlan]:
        """Newest first."""
        ...
    def update(self, plan_id: str, changes: dict[str, Any], *, expected_version: int | None = None) -> RoutePlan:
        """Bumps `version`. ConflictError when `expected_version` no longer matches, NotFoundError when gone."""
        ...
    def put_stops(self, plan_id: str, stops: list[PlanStop]) -> None: ...
    def list_stops(self, plan_id: str) -> list[PlanStop]:
        """The whole plan (the plan page loads it as one bundle)."""
        ...
    def get_stop(self, plan_id: str, key: str) -> PlanStop | None: ...
    def update_assignments(self, plan_id: str, changes: list[PlanStopChange]) -> int:
        """Set installer/day/seq/drive_minutes only, so a visit recorded meanwhile is never overwritten. Stops
        removed meanwhile are skipped. Returns how many were written."""
        ...
    def delete_stop(self, plan_id: str, key: str) -> None: ...
    def record_visit(self, plan_id: str, key: str, screen_id: str) -> PlanStop | None:
        """Add `screen_id` to the stop's visited sticks (once). None when the stop is not in the plan."""
        ...


def check_assignment(change: dict[str, Any]) -> None:
    extra = set(change) - ASSIGNMENT_FIELDS
    if extra:
        raise ValueError(f"Assignment writes may only touch installer/day/seq/drive_minutes, got {sorted(extra)}")


class DynamoRoutePlanRepository:
    def __init__(self, table) -> None:
        self._table = table

    @staticmethod
    def _to_item(plan: RoutePlan) -> dict[str, Any]:
        return {
            **Keys.route_plan(plan.id),
            "entity": "ROUTEPLAN",
            "GSI1PK": Keys.route_plan_list(plan.status.value),
            "GSI1SK": plan.created_at,
            **to_ddb(plan.model_dump(mode="json")),
        }

    @staticmethod
    def _from_item(item: dict[str, Any]) -> RoutePlan:
        return RoutePlan.model_validate(from_ddb(strip_internal(item)))

    @staticmethod
    def _stop_from_item(item: dict[str, Any]) -> PlanStop:
        return PlanStop.model_validate(from_ddb(strip_internal(item)))

    def put(self, plan: RoutePlan) -> None:
        self._table.put_item(Item=self._to_item(plan))

    def get(self, plan_id: str) -> RoutePlan | None:
        item = self._table.get_item(Key=Keys.route_plan(plan_id)).get("Item")
        return self._from_item(item) if item else None

    def list(self, status: PlanStatus, *, limit: int = 50, cursor: str | None = None) -> Page[RoutePlan]:
        kwargs: dict[str, Any] = {
            "IndexName": GSI1,
            "KeyConditionExpression": "GSI1PK = :pk",
            "ExpressionAttributeValues": {":pk": Keys.route_plan_list(status.value)},
            "ScanIndexForward": False,
            "Limit": limit,
        }
        response = query_page(self._table, kwargs, cursor, GSI1_KEY)
        items = [self._from_item(item) for item in response.get("Items", [])]
        return Page(items=items, next_cursor=encode_cursor(response.get("LastEvaluatedKey")))

    def update(self, plan_id: str, changes: dict[str, Any], *, expected_version: int | None = None) -> RoutePlan:
        payload = {key: value for key, value in changes.items() if key not in {"id", "version", "created_at"}}
        payload["updated_at"] = now_iso()
        if "status" in payload:
            payload["GSI1PK"] = Keys.route_plan_list(str(payload["status"]))
        expression, names, values = build_set_expression(payload)
        names["#version"] = "version"
        values[":one"] = 1
        condition = "attribute_exists(PK)"
        if expected_version is not None:
            condition += " AND #version = :expected"
            values[":expected"] = expected_version
        try:
            response = self._table.update_item(
                Key=Keys.route_plan(plan_id),
                UpdateExpression=f"{expression}, #version = #version + :one",
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=values,
                ConditionExpression=condition,
                ReturnValues="ALL_NEW",
            )
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
            if self.get(plan_id) is None:
                raise NotFoundError(f"Route plan {plan_id} not found") from exc
            raise ConflictError("The plan was changed by someone else; reload it and try again") from exc
        return self._from_item(response["Attributes"])

    def put_stops(self, plan_id: str, stops: list[PlanStop]) -> None:
        with self._table.batch_writer(overwrite_by_pkeys=["PK", "SK"]) as batch:
            for stop in stops:
                batch.put_item(Item={
                    **Keys.plan_stop(plan_id, stop.key), "entity": "PLANSTOP", **to_ddb(stop.model_dump(mode="json"))
                })

    def list_stops(self, plan_id: str) -> list[PlanStop]:
        kwargs: dict[str, Any] = {
            "KeyConditionExpression": "PK = :pk AND begins_with(SK, :prefix)",
            "ExpressionAttributeValues": {":pk": Keys.route_plan(plan_id)["PK"], ":prefix": Keys.STOP_PREFIX},
        }
        stops: list[PlanStop] = []
        while True:
            response = self._table.query(**kwargs)
            stops.extend(self._stop_from_item(item) for item in response.get("Items", []))
            last = response.get("LastEvaluatedKey")
            if not last:
                return stops
            kwargs["ExclusiveStartKey"] = last

    def get_stop(self, plan_id: str, key: str) -> PlanStop | None:
        item = self._table.get_item(Key=Keys.plan_stop(plan_id, key)).get("Item")
        return self._stop_from_item(item) if item else None

    def _assign(self, plan_id: str, key: str, change: dict[str, Any]) -> bool:
        expression, names, values = build_set_expression(change)
        try:
            self._table.meta.client.update_item(
                TableName=self._table.name,
                Key=Keys.plan_stop(plan_id, key),
                UpdateExpression=expression,
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=values,
                ConditionExpression="attribute_exists(PK)",
            )
        except ClientError as exc:
            if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return False
            raise
        return True

    def update_assignments(self, plan_id: str, changes: list[PlanStopChange]) -> int:
        for _, change in changes:
            check_assignment(change)
        if not changes:
            return 0
        with ThreadPoolExecutor(max_workers=WRITE_WORKERS) as pool:
            return sum(pool.map(lambda entry: self._assign(plan_id, entry[0], entry[1]), changes))

    def delete_stop(self, plan_id: str, key: str) -> None:
        self._table.delete_item(Key=Keys.plan_stop(plan_id, key))

    def record_visit(self, plan_id: str, key: str, screen_id: str) -> PlanStop | None:
        try:
            response = self._table.update_item(
                Key=Keys.plan_stop(plan_id, key),
                UpdateExpression="SET visited_screens = list_append(if_not_exists(visited_screens, :empty), :one)",
                ConditionExpression="attribute_exists(PK) AND NOT contains(visited_screens, :screen)",
                ExpressionAttributeValues={":empty": [], ":one": [screen_id], ":screen": screen_id},
                ReturnValues="ALL_NEW",
            )
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
            return self.get_stop(plan_id, key)  # already recorded, or not in the plan (None)
        return self._stop_from_item(response["Attributes"])
