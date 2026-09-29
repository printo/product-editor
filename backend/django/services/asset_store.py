"""
Typed interface for reading calendar and ops assets (holidays, calendar
styles, Gen-Z palettes, fonts) through the configured storage backend.

Every read goes through `StorageBackend.read_calendar_asset`, the one place
that decides where an asset lives — local disk, or S3 with the git-seeded
file under STORAGE_ROOT as the default for a key S3 has never held. There
used to be a second local fallback here as well, which could never find
anything the backend's own fallback hadn't.

Callers must keep two failures apart:

- AssetNotFoundError: the asset doesn't exist (never written and no seed,
  or deleted by ops). Safe to treat as "no data".
- CalendarAssetUnavailable: the store couldn't answer (S3 outage, bad
  credentials). The asset may well exist, so don't substitute a default
  that then gets cached or printed as if it were the answer.
"""

import json
from typing import Literal
from services.storage import CalendarAssetUnavailable, get_storage  # noqa: F401 — re-exported


AssetType = Literal['calendar_styles', 'holidays', 'calendar_palettes/genz', 'fonts']


class AssetNotFoundError(FileNotFoundError):
    """Raised when an asset doesn't exist (or was deleted)."""
    pass


def read_asset(asset_type: AssetType, asset_name: str) -> bytes:
    """
    Read a calendar or ops asset from the configured storage backend.

    Args:
        asset_type: Type of asset ('calendar_styles', 'holidays', 'calendar_palettes/genz', 'fonts')
        asset_name: Asset identifier, e.g., 'modern-minimalist', 'en-IN/2026', 'butter'

    Returns:
        Raw bytes (typically JSON file content)

    Raises:
        AssetNotFoundError: the asset doesn't exist.
        CalendarAssetUnavailable: the store couldn't say whether it does.

    S3 Key Format:
        s3://bucket/<S3_PREFIX>/ops-config/{asset_type}/{asset_name}.json
        Example: s3://bucket/product-editor/ops-config/calendar_styles/modern-minimalist.json
    """
    try:
        return get_storage().read_calendar_asset(asset_type, asset_name)
    except FileNotFoundError as exc:
        raise AssetNotFoundError(f"Asset not found: {asset_type}/{asset_name}") from exc


def read_asset_json(asset_type: AssetType, asset_name: str):
    """
    Read and parse a calendar asset as JSON.

    Returns the parsed value as-is — fonts is a JSON list, everything else an
    object — so callers check the type they expect.

    Raises:
        AssetNotFoundError / CalendarAssetUnavailable: as read_asset.
        ValueError: the content isn't UTF-8 JSON (json.JSONDecodeError and
            UnicodeDecodeError are both ValueErrors — catch ValueError).
    """
    content = read_asset(asset_type, asset_name)
    return json.loads(content.decode('utf-8'))


def list_assets(asset_type: AssetType) -> list:
    """
    Sorted names (without '.json') of the assets of one type, from the
    configured storage backend — under S3, the local seeds plus whatever ops
    created in S3, minus what ops deleted. Used by the ops UIs' dropdowns.

    Raises:
        CalendarAssetUnavailable: the store couldn't be listed.
    """
    return get_storage().list_calendar_assets(asset_type)
