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
import shutil
from typing import BinaryIO, List, Optional
from django.conf import settings


class StorageBackend:
    """Abstract base — every method must be implemented by concrete backends."""

    # ── Upload / download ─────────────────────────────────────────────────────
    def save_upload(self, filename: str, content: BinaryIO) -> str:
        """Save an uploaded file and return its storage path / key."""
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
    def save_upload(self, filename: str, content: BinaryIO) -> str:
        path = os.path.join(settings.UPLOADS_DIR, filename)
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
