"""Uploaded spreadsheets and job results: S3 in AWS, a local directory when DT_FILES_BUCKET is empty.

Key layout (shared by both stores): `uploads/<job_id>/<filename>` and `jobs/<job_id>/result.json`.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Protocol

from botocore.exceptions import ClientError

from dolphin_tracker.config import Settings

UPLOAD_PREFIX = "uploads/"
JOB_PREFIX = "jobs/"
_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")


def upload_key(job_id: str, filename: str) -> str:
    safe = _UNSAFE.sub("_", Path(filename).name).strip("._") or "upload"
    return f"{UPLOAD_PREFIX}{job_id}/{safe}"


def result_key(job_id: str) -> str:
    return f"{JOB_PREFIX}{job_id}/result.json"


class FileStore(Protocol):
    is_local: bool

    def presign_upload(self, key: str, content_type: str, *, expires_in: int = 900) -> str: ...
    def presign_download(self, key: str, *, expires_in: int = 900) -> str: ...
    def exists(self, key: str) -> bool: ...
    def get_bytes(self, key: str) -> bytes: ...
    def put_bytes(self, key: str, data: bytes, *, content_type: str = "application/octet-stream") -> None: ...
    def put_json(self, key: str, payload: Any) -> None: ...
    def get_json(self, key: str) -> Any: ...


class S3FileStore:
    is_local = False

    def __init__(self, bucket: str, *, client: Any = None, region: str = "us-east-1") -> None:
        if client is None:
            import boto3
            from botocore.config import Config

            # SigV4 explicitly: buckets created since 2020 reject SigV2 presigned URLs, which boto3 can still pick.
            config = Config(signature_version="s3v4", s3={"addressing_style": "virtual"})
            client = boto3.client("s3", region_name=region, config=config)
        self._bucket = bucket
        self._client = client

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

    def exists(self, key: str) -> bool:
        try:
            self._client.head_object(Bucket=self._bucket, Key=key)
        except ClientError as exc:
            if exc.response["Error"]["Code"] in {"404", "NoSuchKey", "NotFound"}:
                return False
            raise
        return True

    def get_bytes(self, key: str) -> bytes:
        return self._client.get_object(Bucket=self._bucket, Key=key)["Body"].read()

    def put_bytes(self, key: str, data: bytes, *, content_type: str = "application/octet-stream") -> None:
        self._client.put_object(Bucket=self._bucket, Key=key, Body=data, ContentType=content_type)

    def put_json(self, key: str, payload: Any) -> None:
        self.put_bytes(key, json.dumps(payload).encode(), content_type="application/json")

    def get_json(self, key: str) -> Any:
        return json.loads(self.get_bytes(key))


class LocalFileStore:
    """Files under a local directory. URLs point at the API's local-only routes instead of S3.

    Upload: `PUT /api/jobs/{job_id}/upload`. Download: `GET /api/jobs/{job_id}/result`.
    """

    is_local = True

    def __init__(self, root: str | Path) -> None:
        self._root = Path(root).resolve()

    def _path(self, key: str) -> Path:
        path = (self._root / key).resolve()
        if not path.is_relative_to(self._root):
            raise ValueError(f"Key escapes the file store: {key!r}")
        return path

    @staticmethod
    def _job_id(key: str, prefix: str) -> str:
        if not key.startswith(prefix):
            raise ValueError(f"Expected a key under {prefix!r}, got {key!r}")
        return key[len(prefix) :].split("/", 1)[0]

    def presign_upload(self, key: str, content_type: str, *, expires_in: int = 900) -> str:
        return f"/api/jobs/{self._job_id(key, UPLOAD_PREFIX)}/upload"

    def presign_download(self, key: str, *, expires_in: int = 900) -> str:
        return f"/api/jobs/{self._job_id(key, JOB_PREFIX)}/result"

    def exists(self, key: str) -> bool:
        return self._path(key).is_file()

    def get_bytes(self, key: str) -> bytes:
        path = self._path(key)
        if not path.is_file():
            raise FileNotFoundError(key)
        return path.read_bytes()

    def put_bytes(self, key: str, data: bytes, *, content_type: str = "application/octet-stream") -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".part")
        tmp.write_bytes(data)
        tmp.replace(path)  # readers never see a half-written file

    def put_json(self, key: str, payload: Any) -> None:
        self.put_bytes(key, json.dumps(payload).encode(), content_type="application/json")

    def get_json(self, key: str) -> Any:
        return json.loads(self.get_bytes(key))


def make_file_store(settings: Settings) -> FileStore:
    if settings.files_bucket:
        return S3FileStore(settings.files_bucket, region=settings.aws_region)
    return LocalFileStore(settings.local_files_dir)
