"""
In-memory stand-in for the boto3 S3 client, plus a context manager that
swaps the process-wide storage for an S3Storage over it. Shared by the
calendar-asset S3 tests. Not a test module itself (no `test_` prefix), so CI
doesn't run it.

Errors carry botocore's ClientError shape (`exc.response['Error']['Code']`)
because S3Storage tells "no such key" from "S3 couldn't answer" by that code.
"""
from __future__ import annotations

import io
import json
import os
import shutil
import tempfile

from django.conf import settings

from services import storage as storage_mod

BUCKET = "test-bucket"
PREFIX = "product-editor"


class FakeClientError(Exception):
    """Same shape as botocore.exceptions.ClientError."""

    def __init__(self, code: str, status: int):
        super().__init__(f"An error occurred ({code})")
        self.response = {"Error": {"Code": code, "Message": code},
                         "ResponseMetadata": {"HTTPStatusCode": status}}


class FakeS3Client:
    def __init__(self):
        self.objects: dict[str, bytes] = {}
        self.metadata: dict[str, dict] = {}
        self.reads: list[str] = []
        # Set to an exception instance to make every get / put / list raise it.
        self.get_error: Exception | None = None
        self.put_error: Exception | None = None
        self.list_error: Exception | None = None
        self.page_size = 1000

    def get_object(self, Bucket, Key):
        assert Bucket == BUCKET
        self.reads.append(Key)
        if self.get_error is not None:
            raise self.get_error
        if Key not in self.objects:
            raise FakeClientError("NoSuchKey", 404)
        return {"Body": io.BytesIO(self.objects[Key]), "Metadata": dict(self.metadata[Key])}

    def _store(self, key, body: bytes, metadata=None):
        if self.put_error is not None:
            raise self.put_error
        self.objects[key] = body
        self.metadata[key] = dict(metadata or {})

    def upload_fileobj(self, fileobj, bucket, key):
        assert bucket == BUCKET
        self._store(key, fileobj.read())

    def put_object(self, Bucket, Key, Body=b"", Metadata=None):
        assert Bucket == BUCKET
        self._store(Key, Body, Metadata)

    def list_objects_v2(self, Bucket, Prefix, Delimiter=None, ContinuationToken=None):
        assert Bucket == BUCKET
        if self.list_error is not None:
            raise self.list_error
        keys = sorted(k for k in self.objects if k.startswith(Prefix)
                      and not (Delimiter and Delimiter in k[len(Prefix):]))
        start = int(ContinuationToken or 0)
        end = start + self.page_size
        page = {"Contents": [{"Key": k, "Size": len(self.objects[k])} for k in keys[start:end]],
                "IsTruncated": end < len(keys)}
        if page["IsTruncated"]:
            page["NextContinuationToken"] = str(end)
        return page

    def delete_object(self, Bucket, Key):
        self.objects.pop(Key, None)
        self.metadata.pop(Key, None)


class S3Backend:
    """Swap the process-wide storage for an S3Storage over the fake client,
    and STORAGE_ROOT for a temp dir holding the local fallback seeds."""

    def __enter__(self):
        self.client = FakeS3Client()
        self.storage = storage_mod.S3Storage.__new__(storage_mod.S3Storage)
        self.storage.s3 = self.client
        self.storage.bucket = BUCKET
        self.storage.s3_prefix = PREFIX
        self.storage.cdn_domain = ""
        self._prev_storage = storage_mod._storage_instance
        storage_mod._storage_instance = self.storage

        self.root = tempfile.mkdtemp(prefix="pe-cal-s3-")
        self._prev_root = settings.STORAGE_ROOT
        settings.STORAGE_ROOT = self.root
        return self

    def __exit__(self, *exc):
        storage_mod._storage_instance = self._prev_storage
        settings.STORAGE_ROOT = self._prev_root
        shutil.rmtree(self.root, ignore_errors=True)

    @staticmethod
    def key(asset_type: str, name: str) -> str:
        return f"{PREFIX}/ops-config/{asset_type}/{name}.json"

    def seed_local(self, rel_path: str, payload) -> str:
        path = os.path.join(self.root, rel_path)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            json.dump(payload, f)
        return path

    def put(self, asset_type: str, name: str, payload) -> None:
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.storage.write_calendar_asset(asset_type, name, body)

    def stored_json(self, asset_type: str, name: str):
        return json.loads(self.client.objects[self.key(asset_type, name)])
