"""
Backup and restore of the ops-edited config that lives in S3 on production.

Under STORAGE_BACKEND=s3 the ops UI writes holidays, calendar styles, Gen-Z
palettes and fonts to `<S3_PREFIX>/ops-config/`, not to STORAGE_ROOT, so the
`pe-storage-*.tgz` that scripts/backup.sh takes holds only the git seeds and
nothing ops edited. This module archives that prefix.

A deleted asset is a tombstone object (empty body, `pe-tombstone` metadata, see
S3Storage.delete_calendar_asset). It is archived as `<name>.tombstone` and put
back as a tombstone, because restoring it as "absent" would let the git seed
reappear — the very thing the tombstone exists to prevent.

Pure of Django: takes the S3Storage, so tests run it over the in-memory S3.
"""
from __future__ import annotations

import io
import posixpath
import tarfile
from typing import BinaryIO, Dict, Optional

from services.storage import _TOMBSTONE_META, S3Storage

TOMBSTONE_SUFFIX = ".tombstone"
_ROOT = "ops-config/"


def _ops_prefix(storage: S3Storage) -> str:
    return storage._s3_key(_ROOT)


def _list_keys(storage: S3Storage, prefix: str):
    kwargs = {"Bucket": storage.bucket, "Prefix": prefix}
    while True:
        page = storage.s3.list_objects_v2(**kwargs)
        for obj in page.get("Contents") or []:
            if not obj["Key"].endswith("/"):
                yield obj["Key"]
        if not page.get("IsTruncated"):
            return
        kwargs["ContinuationToken"] = page["NextContinuationToken"]


def export_ops_config(storage, fileobj: BinaryIO) -> Optional[Dict[str, int]]:
    """Write every ops-config object to `fileobj` as a .tar.gz.

    Returns {"objects": n, "tombstones": m}, or None when the storage backend
    is not S3 (local ops-config files are already in the storage tarball).
    Any S3 failure raises: a backup that silently skips objects is worse than
    one that fails.
    """
    if not isinstance(storage, S3Storage):
        return None
    prefix = _ops_prefix(storage)
    objects = tombstones = 0
    with tarfile.open(fileobj=fileobj, mode="w:gz") as tar:
        for key in _list_keys(storage, prefix):
            response = storage.s3.get_object(Bucket=storage.bucket, Key=key)
            body = response["Body"].read()
            name = key[len(prefix):]
            if (response.get("Metadata") or {}).get(_TOMBSTONE_META) == "1":
                name += TOMBSTONE_SUFFIX
                body = b""
                tombstones += 1
            info = tarfile.TarInfo(name)
            info.size = len(body)
            tar.addfile(info, io.BytesIO(body))
            objects += 1
    return {"objects": objects, "tombstones": tombstones}


def _safe_member_name(name: str) -> bool:
    normal = posixpath.normpath(name)
    return (
        bool(name)
        and not name.startswith("/")
        and normal == name
        and not normal.startswith("..")
        and ".." not in normal.split("/")
    )


def restore_ops_config(storage, fileobj: BinaryIO, dry_run: bool = False) -> Dict[str, int]:
    """Put an archive made by export_ops_config back into S3.

    Writes only under the ops-config prefix, whatever the archive names, and
    skips anything that is not a plain file with a safe relative name. Existing
    objects at the same key are overwritten; keys the archive does not mention
    are left alone.
    """
    if not isinstance(storage, S3Storage):
        raise RuntimeError("restore_ops_config needs STORAGE_BACKEND=s3")
    prefix = _ops_prefix(storage)
    restored = tombstones = skipped = 0
    with tarfile.open(fileobj=fileobj, mode="r:gz") as tar:
        for member in tar:
            if not member.isfile() or not _safe_member_name(member.name):
                skipped += 1
                continue
            tombstone = member.name.endswith(TOMBSTONE_SUFFIX)
            name = member.name[: -len(TOMBSTONE_SUFFIX)] if tombstone else member.name
            key = prefix + name
            if not dry_run:
                if tombstone:
                    storage.s3.put_object(
                        Bucket=storage.bucket, Key=key, Body=b"",
                        Metadata={_TOMBSTONE_META: "1"},
                    )
                else:
                    storage.s3.put_object(
                        Bucket=storage.bucket, Key=key,
                        Body=tar.extractfile(member).read(),
                        ContentType="application/json",
                    )
            tombstones += tombstone
            restored += 1
    return {"restored": restored, "tombstones": tombstones, "skipped": skipped}
