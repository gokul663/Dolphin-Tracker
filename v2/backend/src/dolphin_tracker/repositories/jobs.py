"""Async job records (imports, routing builds). Items expire 24 h after creation through the table TTL."""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Protocol

from botocore.exceptions import ClientError

from dolphin_tracker.domain.errors import NotFoundError
from dolphin_tracker.domain.models import Job, JobStatus, now_iso
from dolphin_tracker.repositories.dynamo import Keys, build_set_expression, from_ddb, strip_internal, to_ddb

JOB_TTL = timedelta(hours=24)


class JobRepository(Protocol):
    def put(self, job: Job) -> None: ...
    def get(self, job_id: str) -> Job | None: ...
    def set_status(self, job_id: str, status: JobStatus, *, progress: int | None = None, message: str = "") -> Job: ...
    def set_result(self, job_id: str, result_key: str | None, *, message: str = "") -> Job:
        """Mark the job succeeded at 100 % with an optional result object key."""
        ...


def ttl_for(created_at: str) -> int:
    return int((datetime.fromisoformat(created_at) + JOB_TTL).timestamp())


class DynamoJobRepository:
    def __init__(self, table) -> None:
        self._table = table

    @staticmethod
    def _from_item(item: dict[str, Any]) -> Job:
        data = from_ddb(strip_internal(item))
        data.pop("ttl", None)
        return Job.model_validate(data)

    def put(self, job: Job) -> None:
        self._table.put_item(
            Item={
                **Keys.job(job.id),
                "entity": "JOB",
                "ttl": ttl_for(job.created_at),
                **to_ddb(job.model_dump(mode="json")),
            }
        )

    def get(self, job_id: str) -> Job | None:
        item = self._table.get_item(Key=Keys.job(job_id)).get("Item")
        return self._from_item(item) if item else None

    def _update(self, job_id: str, changes: dict[str, Any]) -> Job:
        expression, names, values = build_set_expression({**changes, "updated_at": now_iso()})
        try:
            response = self._table.update_item(
                Key=Keys.job(job_id),
                UpdateExpression=expression,
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=values,
                ConditionExpression="attribute_exists(PK)",
                ReturnValues="ALL_NEW",
            )
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
            raise NotFoundError(f"Job {job_id} not found") from exc
        return self._from_item(response["Attributes"])

    def set_status(self, job_id: str, status: JobStatus, *, progress: int | None = None, message: str = "") -> Job:
        changes: dict[str, Any] = {"status": status.value, "message": message}
        if progress is not None:
            changes["progress"] = max(0, min(100, progress))
        return self._update(job_id, changes)

    def set_result(self, job_id: str, result_key: str | None, *, message: str = "") -> Job:
        return self._update(
            job_id,
            {"status": JobStatus.SUCCEEDED.value, "progress": 100, "result_key": result_key, "message": message},
        )
