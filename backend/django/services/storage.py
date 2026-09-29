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

import logging
import os
import re
import shutil
from typing import BinaryIO, List, Optional
from django.conf import settings

logger = logging.getLogger(__name__)


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


def upload_subdir(order_id: Optional[str], layout_name: Optional[str] = None) -> str:
    """
    Directory name for an order's uploads, optionally grouped by layout.

    Returns structure: {layout_name}/{order_id} if layout_name provided,
    else just {order_id} for backwards compatibility.

    Traversal-safe: anything that is not well-formed falls back to
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

    # Optional layout-based grouping for better S3 organization
    if layout_name:
        # Validate layout_name is safe (alphanumeric + underscore/hyphen)
        if not layout_name or not all(c.isalnum() or c in '_-' for c in layout_name):
            # Fall back to no-layout if invalid
            return oid
        return f"{layout_name}/{oid}"

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
    def save_upload(self, filename: str, content: BinaryIO, order_id: str = "", layout_name: str = "") -> str:
        """Save an uploaded file and return its storage path / key.

        `order_id` selects the per-order directory — see upload_subdir(). Pass
        it wherever it is known so DPDP erasure can find the file by path.
        `layout_name` (optional) groups uploads by layout for better organization:
            local: /app/storage/uploads/{layout_name}/{order_id}/{filename}
            S3:    product-editor/uploads/{layout_name}/{order_id}/{filename}
        """
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

    def read_calendar_asset(self, asset_type: str, asset_name: str) -> bytes:
        """Read a calendar/ops asset (holidays, styles, palettes).

        Args:
            asset_type: 'holidays', 'calendar_styles', 'calendar_palettes', 'fonts'
            asset_name: e.g., 'en-IN/2026', 'modern-minimalist', 'genz/vibrant', 'fonts'

        Returns:
            Raw bytes of the asset file

        Raises:
            FileNotFoundError if the asset doesn't exist
            CalendarAssetUnavailable if the store couldn't say whether it does
        """
        raise NotImplementedError

    def write_calendar_asset(self, asset_type: str, asset_name: str, content: bytes) -> str:
        """Write a calendar/ops asset atomically.

        Args:
            asset_type: 'holidays', 'calendar_styles', 'calendar_palettes', 'fonts'
            asset_name: the asset identifier
            content: raw bytes to write

        Returns:
            The path or S3 key where the asset was written

        Raises:
            IOError on write failure
        """
        raise NotImplementedError

    def delete_calendar_asset(self, asset_type: str, asset_name: str) -> bool:
        """Delete a calendar/ops asset.

        Args:
            asset_type: 'holidays', 'calendar_styles', 'calendar_palettes', 'fonts'
            asset_name: the asset identifier

        Returns:
            True on success, False if the asset didn't exist
        """
        raise NotImplementedError


class LocalStorage(StorageBackend):
    """Concrete backend that stores everything on the local filesystem."""

    # ── Upload / download ─────────────────────────────────────────────────────
    def save_upload(self, filename: str, content: BinaryIO, order_id: str = "", layout_name: str = "") -> str:
        # Build directory with optional layout-based grouping
        subdir = upload_subdir(order_id, layout_name)
        target_dir = order_upload_dir(subdir) if subdir == NO_ORDER_BUCKET else os.path.realpath(os.path.join(os.path.realpath(settings.UPLOADS_DIR), subdir))
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
        # Layouts are now in LayoutCatalogue (Postgres), not on disk
        from api.models import LayoutCatalogue
        return list(
            LayoutCatalogue.objects.filter(is_deprecated=False)
            .values_list('name', flat=True)
        )

    def exports_path(self, name: str) -> str:
        return os.path.join(settings.EXPORTS_DIR, name)

    def layouts_dir(self) -> str:
        return settings.LAYOUTS_DIR

    def masks_dir(self) -> str:
        masks_path = os.path.join(os.path.dirname(settings.LAYOUTS_DIR), "masks")
        os.makedirs(masks_path, exist_ok=True)
        return masks_path

    def read_calendar_asset(self, asset_type: str, asset_name: str) -> bytes:
        return _read_local_calendar_asset(asset_type, asset_name)

    def write_calendar_asset(self, asset_type: str, asset_name: str, content: bytes) -> str:
        """Write a calendar asset atomically using temp + rename."""
        path = _local_calendar_asset_path(asset_type, asset_name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp_path = path + '.tmp'

        try:
            with open(tmp_path, 'wb') as f:
                f.write(content)
            os.replace(tmp_path, path)
            return path
        except Exception:
            if os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
            raise

    def delete_calendar_asset(self, asset_type: str, asset_name: str) -> bool:
        """Delete a calendar asset. Returns True on success, False if not found."""
        path = _local_calendar_asset_path(asset_type, asset_name)
        if os.path.exists(path):
            try:
                os.remove(path)
                return True
            except OSError:
                return False
        return False


class S3Storage(StorageBackend):
    """
    Production storage backend using Amazon S3.

    Layouts: served from Postgres (LayoutCatalogue) — no S3 reads for layout JSON.
    Masks: stored under s3://<bucket>/masks/
    Uploads: stored under s3://<bucket>/uploads/<order_id>/
    Exports: stored under s3://<bucket>/exports/
    Calendar: stored under s3://<bucket>/ops-config/<asset_type>/
    """

    def __init__(self):
        import boto3
        from django.core.exceptions import ImproperlyConfigured

        required = {
            'AWS_ACCESS_KEY_ID': os.getenv('AWS_ACCESS_KEY_ID'),
            'AWS_SECRET_ACCESS_KEY': os.getenv('AWS_SECRET_ACCESS_KEY'),
            'AWS_REGION': os.getenv('AWS_REGION'),
            'S3_BUCKET': os.getenv('S3_BUCKET'),
        }
        missing = [k for k, v in required.items() if not v]
        if missing:
            raise ImproperlyConfigured(
                f"S3Storage: missing required env vars: {missing}. "
                "Set them before starting the server."
            )

        self.s3 = boto3.client(
            's3',
            aws_access_key_id=required['AWS_ACCESS_KEY_ID'],
            aws_secret_access_key=required['AWS_SECRET_ACCESS_KEY'],
            region_name=required['AWS_REGION'],
        )
        self.bucket = required['S3_BUCKET']

        # Optional S3 prefix for service-based organization (e.g., "product-editor")
        self.s3_prefix = os.getenv('S3_PREFIX', 'product-editor')

        # Optional CDN domain for presigned URLs (e.g., "cdn-product-editor.printo.in")
        self.cdn_domain = os.getenv('S3_CDN_DOMAIN', '')

    def _s3_key(self, relative_path: str) -> str:
        """Build full S3 key with service prefix."""
        return f"{self.s3_prefix}/{relative_path}"

    def save_upload(self, filename: str, content: BinaryIO, order_id: str = "", layout_name: str = "") -> str:
        subdir = upload_subdir(order_id, layout_name)
        key = self._s3_key(f"uploads/{subdir}/{filename}")
        self.s3.upload_fileobj(content, self.bucket, key)
        return key

    def read_upload(self, path: str) -> bytes:
        response = self.s3.get_object(Bucket=self.bucket, Key=path)
        return response['Body'].read()

    def delete_file(self, path: str) -> bool:
        try:
            self.s3.delete_object(Bucket=self.bucket, Key=path)
            return True
        except Exception:
            return False

    def file_exists(self, path: str) -> bool:
        try:
            self.s3.head_object(Bucket=self.bucket, Key=path)
            return True
        except self.s3.exceptions.ClientError as exc:
            if exc.response['Error']['Code'] in ('404', 'NoSuchKey'):
                return False
            raise

    def chunked_staging_dir(self, upload_id: str) -> str:
        return f"uploads/.chunks/{upload_id}"

    def assemble_chunks(self, upload_id: str, final_filename: str, total_chunks: int) -> str:
        staging_prefix = self.chunked_staging_dir(upload_id)
        final_key = self._s3_key(f"uploads/{final_filename}")

        mpu = self.s3.create_multipart_upload(Bucket=self.bucket, Key=final_key)
        upload_id_s3 = mpu['UploadId']

        parts = []
        try:
            for idx in range(total_chunks):
                part_key = f"{staging_prefix}/{idx}.part"
                copy_response = self.s3.upload_part_copy(
                    Bucket=self.bucket,
                    CopySource={'Bucket': self.bucket, 'Key': part_key},
                    Key=final_key,
                    UploadId=upload_id_s3,
                    PartNumber=idx + 1,
                )
                parts.append({
                    'PartNumber': idx + 1,
                    'ETag': copy_response['CopyPartResult']['ETag'],
                })
        except Exception as exc:
            self.s3.abort_multipart_upload(
                Bucket=self.bucket, Key=final_key, UploadId=upload_id_s3
            )
            raise RuntimeError(
                f"S3 chunk assembly failed at part {idx} for upload {upload_id}: {exc}"
            ) from exc

        self.s3.complete_multipart_upload(
            Bucket=self.bucket,
            Key=final_key,
            UploadId=upload_id_s3,
            MultipartUpload={'Parts': parts},
        )

        for idx in range(total_chunks):
            self.s3.delete_object(Bucket=self.bucket, Key=f"{staging_prefix}/{idx}.part")

        return final_key

    def list_layouts(self) -> List[str]:
        from api.models import LayoutCatalogue
        return list(
            LayoutCatalogue.objects.filter(is_deprecated=False)
            .values_list('name', flat=True)
        )

    def exports_path(self, name: str) -> str:
        return self._s3_key(f"exports/{name}")

    def layouts_dir(self) -> str:
        return f"s3://{self.bucket}/{self.s3_prefix}/layouts/"

    def masks_dir(self) -> str:
        return f"s3://{self.bucket}/{self.s3_prefix}/masks/"

    def generate_mask_presigned_url(self, s3_key: str, expiry: int = 3600) -> str:
        # If CDN domain is configured, construct CDN URL instead of presigned S3 URL
        if self.cdn_domain:
            # Remove bucket prefix from s3_key if present (it shouldn't be)
            return f"https://{self.cdn_domain}/{s3_key}"

        return self.s3.generate_presigned_url(
            'get_object',
            Params={'Bucket': self.bucket, 'Key': s3_key},
            ExpiresIn=expiry,
        )

    def copy_object(self, source_key: str, dest_key: str) -> None:
        self.s3.copy_object(
            CopySource={'Bucket': self.bucket, 'Key': source_key},
            Bucket=self.bucket,
            Key=dest_key,
        )

    def _calendar_asset_key(self, asset_type: str, asset_name: str) -> str:
        """The one S3 key for a calendar asset — read, write and delete all use it.

        Read used to build its own key with neither the service prefix nor the
        `.json` suffix, so it never found an object write had put there and
        every read silently fell back to local disk: under S3, an ops edit
        reached neither the preview nor the print.
        """
        return self._s3_key(f"ops-config/{asset_type}/{_json_asset_name(asset_name)}")

    def read_calendar_asset(self, asset_type: str, asset_name: str) -> bytes:
        """S3 first; the git-seeded file under STORAGE_ROOT only for a key S3
        has never held.

        The seed is a default, not a backup. Once ops has written or deleted
        a key, S3 is the only thing that knows its state, so two cases must
        NOT reach the seed: a key ops deleted (it holds a tombstone — see
        delete_calendar_asset) and a read S3 couldn't answer (outage, bad
        credentials, timeout), which raises CalendarAssetUnavailable instead.
        This used to fall back on any exception, which undid every ops
        DELETE of a seeded year and let an outage serve the seed as if it
        were the ops-edited asset.
        """
        s3_key = self._calendar_asset_key(asset_type, asset_name)
        try:
            response = self.s3.get_object(Bucket=self.bucket, Key=s3_key)
        except Exception as exc:
            code = _s3_error_code(exc)
            if code not in _S3_ABSENT_CODES:
                raise CalendarAssetUnavailable(f"S3 read failed for {s3_key}: {exc}") from exc
            logger.debug("%s not in S3 (%s); reading the local seed", s3_key, code)
            return _read_local_calendar_asset(asset_type, asset_name)

        if (response.get('Metadata') or {}).get(_TOMBSTONE_META) == '1':
            raise FileNotFoundError(
                f"Calendar asset deleted: asset_type={asset_type!r}, asset_name={asset_name!r}"
            )
        try:
            return response['Body'].read()
        except Exception as exc:
            raise CalendarAssetUnavailable(f"S3 read failed for {s3_key}: {exc}") from exc

    def write_calendar_asset(self, asset_type: str, asset_name: str, content: bytes) -> str:
        """Write a calendar asset to S3 atomically."""
        s3_key = self._calendar_asset_key(asset_type, asset_name)
        try:
            import io
            self.s3.upload_fileobj(
                io.BytesIO(content),
                self.bucket,
                s3_key,
            )
            return s3_key
        except Exception as exc:
            raise IOError(f"Failed to write calendar asset to S3: {exc}") from exc

    def delete_calendar_asset(self, asset_type: str, asset_name: str) -> bool:
        """Replace the object with a tombstone rather than removing it.

        A removed key reads as "never written", which falls back to the
        git-seeded file — so a plain DeleteObject resurrected the seed on the
        next read. A later write replaces the tombstone like any other object.

        Always True: S3 can't cheaply say whether there was anything to
        delete. A failure raises, so the caller doesn't report a 204 for a
        delete that never happened.
        """
        s3_key = self._calendar_asset_key(asset_type, asset_name)
        try:
            self.s3.put_object(
                Bucket=self.bucket, Key=s3_key, Body=b'', Metadata={_TOMBSTONE_META: '1'},
            )
        except Exception as exc:
            raise IOError(f"Failed to delete calendar asset in S3: {exc}") from exc
        return True


class CalendarAssetUnavailable(Exception):
    """The store couldn't say whether a calendar asset exists.

    Deliberately not a FileNotFoundError: "missing" may fall back to the
    seed or to "no data", but here the asset may well exist, so a caller
    that substitutes a default would cache or print it as the real answer.
    """


# S3 user-metadata flag (sent as x-amz-meta-pe-tombstone) marking a deleted
# calendar asset.
_TOMBSTONE_META = 'pe-tombstone'

# Error codes meaning "no object at this key". AccessDenied is included
# because S3 answers a GET for a missing key with 403 AccessDenied instead of
# 404 when the caller lacks s3:ListBucket on the bucket — the client cannot
# tell the two apart, and treating it as an outage would make every
# never-written asset unreadable under such a policy.
_S3_ABSENT_CODES = frozenset({'NoSuchKey', 'NotFound', '404', 'AccessDenied'})


def _s3_error_code(exc: Exception) -> Optional[str]:
    """The S3 error code of a botocore ClientError; None for anything else
    (connection errors, timeouts), which carry no response."""
    response = getattr(exc, 'response', None)
    if not isinstance(response, dict):
        return None
    return (response.get('Error') or {}).get('Code')


def _json_asset_name(asset_name: str) -> str:
    """Calendar assets are all JSON files; callers name them without the suffix."""
    return asset_name if asset_name.endswith('.json') else asset_name + '.json'


def _local_calendar_asset_path(asset_type: str, asset_name: str) -> str:
    """The one local path for a calendar asset: LocalStorage's file, and the
    git-seeded default S3Storage falls back to. Names may nest ('en-IN/2026')."""
    return os.path.join(settings.STORAGE_ROOT, asset_type, _json_asset_name(asset_name))


def _read_local_calendar_asset(asset_type: str, asset_name: str) -> bytes:
    try:
        with open(_local_calendar_asset_path(asset_type, asset_name), 'rb') as fh:
            return fh.read()
    except FileNotFoundError:
        raise FileNotFoundError(
            f"Calendar asset not found: asset_type={asset_type!r}, asset_name={asset_name!r}"
        ) from None
    except OSError as exc:
        raise CalendarAssetUnavailable(f"Local calendar asset unreadable: {exc}") from exc


_storage_instance: Optional[StorageBackend] = None


def get_storage() -> StorageBackend:
    global _storage_instance
    if _storage_instance is None:
        backend = os.getenv("STORAGE_BACKEND", "local")
        if backend == "s3":
            _storage_instance = S3Storage()
        else:
            _storage_instance = LocalStorage()
    return _storage_instance
