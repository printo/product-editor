"""
Storage abstraction layer.

Switch between local-disk and cloud (S3 / GCS) by setting the
STORAGE_BACKEND env var:

    STORAGE_BACKEND=local    →  LocalStorage   (default, current)
    STORAGE_BACKEND=s3       →  S3Storage       (future — implement below)

Every storage operation goes through the StorageBackend interface so the
rest of the codebase never touches raw file paths or boto3 directly.
When you're ready to migrate to S3:
  1. pip install boto3
  2. Implement S3Storage below
  3. Set STORAGE_BACKEND=s3 + AWS_* env vars
  4. Done — no application code changes required.
"""

import os
import re
import shutil
from typing import BinaryIO, List, Optional
from django.conf import settings


# ── Per-order upload layout ──────────────────────────────────────────────────
#
# Uploads live under UPLOADS_DIR/<order_id>/ rather than flat. That single
# change makes ownership visible in the path, which is what lets DPDP erasure
# do a true *discovery* pass — "remove this order's directory" — instead of
# depending on database rows to enumerate which files belonged to whom.
#
# Before this, a customer's files were stored as UPLOADS_DIR/<random8>_<name>
# with nothing in the path identifying the owner. If the rows pointing at them
# were lost, the bytes were unreachable by any order-scoped erasure. See
# docs/DPDP_ERASURE_GAP_PRD.md.

# Uploads with no order context (the direct partner API uploads before any
# order exists). Kept as a real bucket rather than the root so the root only
# ever contains directories.
NO_ORDER_BUCKET = "_no_order"

# Same shape the API validates order_id against at session creation.
_ORDER_ID_RE = re.compile(r'^[A-Za-z0-9_.\-]{1,64}$')


def upload_subdir(order_id: Optional[str]) -> str:
    """
    Directory name for an order's uploads.

    Traversal-safe: anything that is not a well-formed order id falls back to
    the no-order bucket rather than being interpolated into a path.

    The regex alone is NOT sufficient. '.' is a legal order-id character, so
    `..` (and `.`, `...`) match it — and `join(UPLOADS_DIR, '..')` is the parent
    of the uploads root, which a purge would then try to rmtree. Dot-only names
    and anything leading with a dot are rejected explicitly. order_upload_dir()
    re-checks containment as a second line of defence.
    """
    oid = (order_id or '').strip()
    if not _ORDER_ID_RE.match(oid):
        return NO_ORDER_BUCKET
    if oid.startswith('.') or set(oid) == {'.'}:
        return NO_ORDER_BUCKET
    return oid


def order_upload_dir(order_id: Optional[str]) -> str:
    """
    Absolute directory holding one order's uploads.

    Asserts the result stays inside UPLOADS_DIR. upload_subdir() should already
    guarantee that; this catches the case where it is ever loosened, because the
    caller of this function deletes what it returns.
    """
    root = os.path.realpath(settings.UPLOADS_DIR)
    candidate = os.path.realpath(os.path.join(root, upload_subdir(order_id)))
    if candidate != root and not candidate.startswith(root + os.sep):
        # Should be unreachable. Fail closed into the shared bucket rather than
        # handing a caller a path outside the uploads tree.
        return os.path.join(root, NO_ORDER_BUCKET)
    return candidate


class StorageBackend:
    """Abstract base — every method must be implemented by concrete backends."""

    # ── Upload / download ─────────────────────────────────────────────────────
    def save_upload(self, filename: str, content: BinaryIO, order_id: str = "") -> str:
        """Save an uploaded file and return its storage path / key.

        `order_id` selects the per-order directory — see upload_subdir(). Pass
        it wherever it is known so DPDP erasure can find the file by path."""
        raise NotImplementedError

    def read_upload(self, path: str) -> bytes:
        """Return raw bytes for an uploaded file."""
        raise NotImplementedError

    def delete_file(self, path: str) -> bool:
        """Delete a single file.  Returns True on success."""
        raise NotImplementedError

    def file_exists(self, path: str) -> bool:
        raise NotImplementedError

    # ── Chunked upload helpers ────────────────────────────────────────────────
    def chunked_staging_dir(self, upload_id: str) -> str:
        """Return a staging location for chunk parts.  Local: a directory.
        S3: a prefix in a staging bucket."""
        raise NotImplementedError

    def assemble_chunks(self, upload_id: str, final_filename: str, total_chunks: int) -> str:
        """Concatenate chunk parts 0..(total_chunks-1) into a final upload
        and clean up the staging area.  Returns the final path / key."""
        raise NotImplementedError

    # ── Layout / export directories ───────────────────────────────────────────
    def list_layouts(self) -> List[str]:
        raise NotImplementedError

    def exports_path(self, name: str) -> str:
        raise NotImplementedError

    def layouts_dir(self) -> str:
        raise NotImplementedError

    def masks_dir(self) -> str:
        raise NotImplementedError


class LocalStorage(StorageBackend):
    """Concrete backend that stores everything on the local filesystem."""

    # ── Upload / download ─────────────────────────────────────────────────────
    def save_upload(self, filename: str, content: BinaryIO, order_id: str = "") -> str:
        target_dir = order_upload_dir(order_id)
        os.makedirs(target_dir, exist_ok=True)
        path = os.path.join(target_dir, filename)
        with open(path, "wb") as out:
            chunk = content.read(8192)
            while chunk:
                out.write(chunk)
                chunk = content.read(8192)
        return path

    def read_upload(self, path: str) -> bytes:
        with open(path, "rb") as f:
            return f.read()

    def delete_file(self, path: str) -> bool:
        try:
            os.remove(path)
            return True
        except OSError:
            return False

    def file_exists(self, path: str) -> bool:
        return os.path.isfile(path)

    # ── Chunked upload helpers ────────────────────────────────────────────────
    def chunked_staging_dir(self, upload_id: str) -> str:
        d = os.path.join(settings.UPLOADS_DIR, '.chunks', upload_id)
        os.makedirs(d, exist_ok=True)
        return d

    def assemble_chunks(self, upload_id: str, final_filename: str, total_chunks: int) -> str:
        staging = self.chunked_staging_dir(upload_id)
        final_path = os.path.join(settings.UPLOADS_DIR, final_filename)
        with open(final_path, 'wb') as out:
            for idx in range(total_chunks):
                with open(os.path.join(staging, f'{idx}.part'), 'rb') as cp:
                    shutil.copyfileobj(cp, out)
        shutil.rmtree(staging, ignore_errors=True)
        return final_path

    # ── Layout / export directories ───────────────────────────────────────────
    def list_layouts(self) -> List[str]:
        items = []
        for name in os.listdir(settings.LAYOUTS_DIR):
            if name.endswith(".json"):
                items.append(os.path.splitext(name)[0])
        return sorted(items)

    def exports_path(self, name: str) -> str:
        return os.path.join(settings.EXPORTS_DIR, name)

    def layouts_dir(self) -> str:
        return settings.LAYOUTS_DIR

    def masks_dir(self) -> str:
        masks_path = os.path.join(os.path.dirname(settings.LAYOUTS_DIR), "masks")
        os.makedirs(masks_path, exist_ok=True)
        return masks_path


# ── Future: S3Storage ─────────────────────────────────────────────────────────
# class S3Storage(StorageBackend):
#     """Drop-in replacement using boto3.  Set STORAGE_BACKEND=s3 to activate."""
#
#     def __init__(self):
#         import boto3
#         self.s3 = boto3.client('s3',
#             aws_access_key_id=os.getenv('AWS_ACCESS_KEY_ID'),
#             aws_secret_access_key=os.getenv('AWS_SECRET_ACCESS_KEY'),
#             region_name=os.getenv('AWS_REGION', 'ap-south-1'),
#         )
#         self.bucket = os.getenv('S3_BUCKET')
#
#     def save_upload(self, filename, content):
#         key = f"uploads/{filename}"
#         self.s3.upload_fileobj(content, self.bucket, key)
#         return key
#
#     def assemble_chunks(self, upload_id, final_filename, total_chunks):
#         # Use S3 multipart upload API to compose parts server-side.
#         ...
#
#     ... (implement remaining methods)


_storage_instance: Optional[StorageBackend] = None


def get_storage() -> StorageBackend:
    global _storage_instance
    if _storage_instance is None:
        backend = os.getenv("STORAGE_BACKEND", "local")
        if backend == "s3":
            # Uncomment S3Storage above and use it here:
            # _storage_instance = S3Storage()
            raise NotImplementedError("S3 backend not yet implemented — set STORAGE_BACKEND=local")
        else:
            _storage_instance = LocalStorage()
    return _storage_instance
