"""Stop items (one per store, planning data + field progress) under the project's partition."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import Any, Protocol

from botocore.exceptions import ClientError

from dolphin_tracker.domain.cursors import encode_cursor
from dolphin_tracker.domain.errors import ConflictError, NotFoundError
from dolphin_tracker.domain.models import (
    DEVICE_FIELDS,
    PROGRESS_FIELDS,
    ROUTING_FIELDS,
    Page,
    Screen,
    Stop,
    derive_store_status,
    now_iso,
)
from dolphin_tracker.repositories.dynamo import Keys, build_set_expression, from_ddb, query_page, strip_internal, to_ddb

IMMUTABLE_STOP_FIELDS = {"uid", "external_id"}  # the IBC# is set on create/append only (STORE-MODEL §7 #5)
ROUTING_WRITE_WORKERS = 16
STOPS_PER_TRANSACTION = 50  # stop + marker = 2 items; DynamoDB allows 100 per TransactWriteItems

RoutingChange = tuple[str, dict[str, Any]]  # uid, {installer?, day?, seq?}


class StoreRepository(Protocol):
    def put_many(self, project_id: str, stops: list[Stop]) -> None:
        """Write stops. A stop with an `external_id` is written together with its `EXT#` marker in one
        transaction; ConflictError if another stop of the project already holds that IBC# (re-putting the same
        stop is fine)."""
        ...
    def get(self, project_id: str, stop_uid: str) -> Stop | None: ...
    def list(self, project_id: str, *, limit: int = 50, cursor: str | None = None) -> Page[Stop]: ...
    def list_all(self, project_id: str) -> list[Stop]:
        """Whole-project read for routing builds, the map pins endpoint and the routes bundle."""
        ...
    def update_fields(self, project_id: str, stop_uid: str, changes: dict[str, Any]) -> Stop:
        """Partial update; a dotted key (`fields.dma`) sets one entry of the `fields` map.

        Callers keep routing, progress and detail writes separate (AGENT-HANDOFF §2 rule 5).
        """
        ...
    def update_routing_many(self, project_id: str, changes: list[RoutingChange]) -> int:
        """Apply installer/day/seq diffs. Stops deleted meanwhile are skipped. Returns how many were written."""
        ...
    def update_progress_many(self, project_id: str, changes: list[RoutingChange]) -> int:
        """Apply progress-field changes (e.g. `installer_name` on a rename) to many stops, in parallel like the
        routing writes. Keys outside PROGRESS_FIELDS are rejected. Returns how many were written."""
        ...
    def set_external_id(self, project_id: str, stop_uid: str, external_id: str, needs_attention: list[str]) -> Stop:
        """Give a store without an IBC# its IBC# (with its EXT# marker, in one transaction). ConflictError when another
        store holds it or this store already has one; NotFoundError when the store is gone."""
        ...
    def update_device_many(self, project_id: str, changes: list[RoutingChange]) -> int:
        """The device sync's writes (DEVICE_FIELDS only), in parallel. Returns how many were written."""
        ...
    def update_screens(self, project_id: str, stop_uid: str, screens: list[Screen], *, updated_by: str = "") -> Stop:
        """Replace the screen rows; writes `screens`, the derived `status` and `updated_*` only."""
        ...
    def delete_all(self, project_id: str) -> int:
        """Every stop of the project, its IBC# markers and its visits. Returns the number of stops."""
        ...
    def claim_for_plan(self, project_id: str, stop_uids: list[str], plan_id: str, at: str) -> list[str]:
        """Set `route_plan_id = plan_id` and `last_planned_at = at` on each stop that is in no plan (one active plan
        per store, ROUTE-PLANNER §3). Returns the uids that were claimed; the rest are in another plan or gone."""
        ...
    def release_from_plan(self, project_id: str, stop_uids: list[str], plan_id: str) -> int:
        """Clear `route_plan_id` where it is still `plan_id`. Returns how many were released."""
        ...
    def list_projected(self, project_id: str, attributes: tuple[str, ...]) -> list[dict[str, Any]]:
        """Whole project, only `attributes` per stop (cheap reads for KPIs). Plain dicts, no Decimals."""
        ...


def screens_write(screens: list[Screen], updated_by: str = "") -> dict[str, Any]:
    """The attributes a screens write sets: the rows, their derived summary, and who changed them."""
    changes: dict[str, Any] = {
        "screens": [screen.model_dump(mode="json") for screen in screens],
        "status": derive_store_status(screens).value,
    }
    if updated_by:
        changes["updated_by"] = updated_by
    return changes


def check_routing_change(changes: dict[str, Any]) -> None:
    extra = set(changes) - ROUTING_FIELDS
    if extra:
        raise ValueError(f"Routing writes may only touch installer/day/seq, got {sorted(extra)}")


def check_device_change(changes: dict[str, Any]) -> None:
    extra = set(changes) - DEVICE_FIELDS
    if extra:
        raise ValueError(f"Device-sync writes may only touch {sorted(DEVICE_FIELDS)}, got {sorted(extra)}")


def check_progress_change(changes: dict[str, Any]) -> None:
    extra = set(changes) - PROGRESS_FIELDS
    if extra:
        raise ValueError(f"Progress writes may only touch progress fields, got {sorted(extra)}")


class DynamoStoreRepository:
    def __init__(self, table) -> None:
        self._table = table

    @staticmethod
    def _to_item(project_id: str, stop: Stop) -> dict[str, Any]:
        return {**Keys.stop(project_id, stop.uid), "entity": "STOP", **to_ddb(stop.model_dump(mode="json"))}

    @staticmethod
    def _from_item(item: dict[str, Any]) -> Stop:
        return Stop.model_validate(from_ddb(strip_internal(item)))

    def put_many(self, project_id: str, stops: list[Stop]) -> None:
        keyed = [stop for stop in stops if stop.external_id]
        ids = [stop.external_id for stop in keyed]
        if len(set(ids)) != len(ids):
            duplicate = next(external_id for external_id in ids if ids.count(external_id) > 1)
            raise ConflictError(f"IBC# {duplicate} appears twice in this write")
        # batch_writer sends 25 items per BatchWriteItem and resubmits UnprocessedItems itself.
        with self._table.batch_writer(overwrite_by_pkeys=["PK", "SK"]) as batch:
            for stop in stops:
                if not stop.external_id:
                    batch.put_item(Item=self._to_item(project_id, stop))
        for start in range(0, len(keyed), STOPS_PER_TRANSACTION):
            self._put_with_markers(project_id, keyed[start : start + STOPS_PER_TRANSACTION])

    def _put_with_markers(self, project_id: str, stops: list[Stop]) -> None:
        """Each stop and its `EXT#` marker in one transaction. The marker must be new, or already this stop's."""
        items = []
        for stop in stops:
            marker = {**Keys.external_id(project_id, stop.external_id), "entity": "EXT", "stop_uid": stop.uid}
            items.append({"Put": {"TableName": self._table.name, "Item": self._to_item(project_id, stop)}})
            items.append({
                "Put": {
                    "TableName": self._table.name,
                    "Item": marker,
                    "ConditionExpression": "attribute_not_exists(PK) OR stop_uid = :uid",
                    "ExpressionAttributeValues": {":uid": stop.uid},
                }
            })
        try:
            self._table.meta.client.transact_write_items(TransactItems=items)
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "TransactionCanceledException":
                raise
            reasons = exc.response.get("CancellationReasons") or []
            failed = next(
                (index for index, reason in enumerate(reasons) if reason.get("Code") == "ConditionalCheckFailed"), None
            )
            external_id = stops[failed // 2].external_id if failed is not None else "?"
            raise ConflictError(f"IBC# {external_id} already exists in this project") from exc

    def set_external_id(self, project_id: str, stop_uid: str, external_id: str, needs_attention: list[str]) -> Stop:
        marker = {**Keys.external_id(project_id, external_id), "entity": "EXT", "stop_uid": stop_uid}
        try:
            self._table.meta.client.transact_write_items(TransactItems=[
                {"Put": {"TableName": self._table.name, "Item": marker,
                         "ConditionExpression": "attribute_not_exists(PK)"}},
                {"Update": {
                    "TableName": self._table.name,
                    "Key": Keys.stop(project_id, stop_uid),
                    "UpdateExpression": "SET external_id = :id, needs_attention = :na, updated_at = :now",
                    "ConditionExpression": (
                        "attribute_exists(PK) AND (attribute_not_exists(external_id) OR external_id = :none)"
                    ),
                    "ExpressionAttributeValues": {":id": external_id, ":na": needs_attention, ":now": now_iso(),
                                                  ":none": ""},
                }},
            ])
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "TransactionCanceledException":
                raise
            reasons = exc.response.get("CancellationReasons") or []
            if reasons and reasons[0].get("Code") == "ConditionalCheckFailed":
                raise ConflictError(f"IBC# {external_id} already exists in this project") from exc
            if self.get(project_id, stop_uid) is None:
                raise NotFoundError(f"Stop {stop_uid} not found") from exc
            raise ConflictError("This store already has an IBC#") from exc
        stop = self.get(project_id, stop_uid)
        assert stop is not None
        return stop

    def get(self, project_id: str, stop_uid: str) -> Stop | None:
        item = self._table.get_item(Key=Keys.stop(project_id, stop_uid)).get("Item")
        return self._from_item(item) if item else None

    def _query_kwargs(self, project_id: str, prefix: str = Keys.STOP_PREFIX) -> dict[str, Any]:
        return {
            "KeyConditionExpression": "PK = :pk AND begins_with(SK, :prefix)",
            "ExpressionAttributeValues": {":pk": Keys.project(project_id)["PK"], ":prefix": prefix},
        }

    def list(self, project_id: str, *, limit: int = 50, cursor: str | None = None) -> Page[Stop]:
        kwargs = {**self._query_kwargs(project_id), "Limit": limit}
        response = query_page(self._table, kwargs, cursor)
        items = [self._from_item(item) for item in response.get("Items", [])]
        return Page(items=items, next_cursor=encode_cursor(response.get("LastEvaluatedKey")))

    def _iter_items(self, project_id: str, prefix: str = Keys.STOP_PREFIX, **extra: Any):
        kwargs = {**self._query_kwargs(project_id, prefix), **extra}
        while True:
            response = self._table.query(**kwargs)
            yield from response.get("Items", [])
            last = response.get("LastEvaluatedKey")
            if not last:
                return
            kwargs["ExclusiveStartKey"] = last

    def list_all(self, project_id: str) -> list[Stop]:
        return [self._from_item(item) for item in self._iter_items(project_id)]

    def update_fields(self, project_id: str, stop_uid: str, changes: dict[str, Any]) -> Stop:
        payload = {key: value for key, value in changes.items() if key not in IMMUTABLE_STOP_FIELDS}
        payload["updated_at"] = now_iso()
        expression, names, values = build_set_expression(payload)
        try:
            response = self._table.update_item(
                Key=Keys.stop(project_id, stop_uid),
                UpdateExpression=expression,
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=values,
                ConditionExpression="attribute_exists(PK)",
                ReturnValues="ALL_NEW",
            )
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
            raise NotFoundError(f"Stop {stop_uid} not found") from exc
        return self._from_item(response["Attributes"])

    def _write_partial(self, project_id: str, stop_uid: str, changes: dict[str, Any], updated_at: str) -> bool:
        # Clients are thread-safe, resource objects are not. The resource's client still applies boto3's
        # DynamoDB type transformation, so plain Python values go in here.
        expression, names, values = build_set_expression({**changes, "updated_at": updated_at})
        try:
            self._table.meta.client.update_item(
                TableName=self._table.name,
                Key=Keys.stop(project_id, stop_uid),
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

    def update_routing_many(self, project_id: str, changes: list[RoutingChange]) -> int:
        for _, change in changes:
            check_routing_change(change)
        if not changes:
            return 0
        updated_at = now_iso()
        with ThreadPoolExecutor(max_workers=ROUTING_WRITE_WORKERS) as pool:
            results = pool.map(
                lambda entry: self._write_partial(project_id, entry[0], entry[1], updated_at), changes
            )
            return sum(1 for written in results if written)

    def update_progress_many(self, project_id: str, changes: list[RoutingChange]) -> int:
        for _, change in changes:
            check_progress_change(change)
        if not changes:
            return 0
        updated_at = now_iso()
        with ThreadPoolExecutor(max_workers=ROUTING_WRITE_WORKERS) as pool:
            results = pool.map(
                lambda entry: self._write_partial(project_id, entry[0], entry[1], updated_at), changes
            )
            return sum(1 for written in results if written)

    def update_device_many(self, project_id: str, changes: list[RoutingChange]) -> int:
        for _, change in changes:
            check_device_change(change)
        if not changes:
            return 0
        updated_at = now_iso()
        with ThreadPoolExecutor(max_workers=ROUTING_WRITE_WORKERS) as pool:
            results = pool.map(
                lambda entry: self._write_partial(project_id, entry[0], entry[1], updated_at), changes
            )
            return sum(1 for written in results if written)

    def list_projected(self, project_id: str, attributes: tuple[str, ...]) -> list[dict[str, Any]]:
        names = {f"#p{index}": name for index, name in enumerate(attributes)}
        items = self._iter_items(
            project_id, ProjectionExpression=", ".join(names), ExpressionAttributeNames=names
        )  # aliased: `status` is a DynamoDB reserved word
        return [from_ddb(item) for item in items]

    def update_screens(self, project_id: str, stop_uid: str, screens: list[Screen], *, updated_by: str = "") -> Stop:
        return self.update_fields(project_id, stop_uid, screens_write(screens, updated_by))

    def _plan_write(self, project_id: str, stop_uid: str, expression: str, condition: str,
                    values: dict[str, Any]) -> bool:
        try:
            self._table.meta.client.update_item(
                TableName=self._table.name,
                Key=Keys.stop(project_id, stop_uid),
                UpdateExpression=expression,
                ConditionExpression=condition,
                ExpressionAttributeValues=values,
            )
        except ClientError as exc:
            if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return False
            raise
        return True

    def claim_for_plan(self, project_id: str, stop_uids: list[str], plan_id: str, at: str) -> list[str]:
        def claim(uid: str) -> bool:
            return self._plan_write(
                project_id, uid,
                "SET route_plan_id = :plan, last_planned_at = :at",
                "attribute_exists(PK) AND (attribute_not_exists(route_plan_id) OR route_plan_id = :none)",
                {":plan": plan_id, ":at": at, ":none": ""},
            )

        with ThreadPoolExecutor(max_workers=ROUTING_WRITE_WORKERS) as pool:
            results = list(pool.map(claim, stop_uids))
        return [uid for uid, claimed in zip(stop_uids, results, strict=True) if claimed]

    def release_from_plan(self, project_id: str, stop_uids: list[str], plan_id: str) -> int:
        def release(uid: str) -> bool:
            return self._plan_write(
                project_id, uid, "SET route_plan_id = :none", "route_plan_id = :plan", {":plan": plan_id, ":none": ""}
            )

        with ThreadPoolExecutor(max_workers=ROUTING_WRITE_WORKERS) as pool:
            return sum(pool.map(release, stop_uids))

    def delete_all(self, project_id: str) -> int:
        def keys(prefix: str) -> list[dict[str, str]]:
            items = self._iter_items(project_id, prefix, ProjectionExpression="PK, SK")
            return [{"PK": item["PK"], "SK": item["SK"]} for item in items]

        # Visits live in the same partition (repositories/visits.py) and go with the project.
        stops, markers, visits = keys(Keys.STOP_PREFIX), keys(Keys.EXTERNAL_ID_PREFIX), keys(Keys.VISIT_PREFIX)
        reviews = keys(Keys.DEVICE_REVIEW_PREFIX)  # the device sync's review list (repositories/device_review.py)
        with self._table.batch_writer() as batch:
            for key in stops + markers + visits + reviews:
                batch.delete_item(Key=key)
        return len(stops)
