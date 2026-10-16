"""S3 access for uploaded spreadsheets and job results."""
from __future__ import annotations

import json
from typing import Any

import boto3

from dolphin_tracker.config import Settings


class FileStore:
    UPLOAD_PREFIX = "uploads/"
    JOB_PREFIX = "jobs/"

    def __init__(self, settings: Settings) -> None:
        self._bucket = settings.files_bucket
        self._client = boto3.client("s3", region_name=settings.aws_region)

    def presign_upload(self, key: str, content_type: str, *, expires_in: int = 900) -> str:
        return self._client.generate_presigned_url(
            "put_object",
            Params={"Bucket": self._bucket, "Key": key, "ContentType": content_type},
            ExpiresIn=expires_in,
        )

    def presign_download(self, key: str, *, expires_in: int = 900) -> str:
        return self._client.generate_presigned_url(
            "get_object", Params={"Bucket": self._bucket, "Key": key}, ExpiresIn=expires_in
        )

    def get_bytes(self, key: str) -> bytes:
        return self._client.get_object(Bucket=self._bucket, Key=key)["Body"].read()

    def put_json(self, key: str, payload: Any) -> None:
        self._client.put_object(
            Bucket=self._bucket, Key=key, Body=json.dumps(payload).encode(), ContentType="application/json"
        )
