"""
Typed interface for reading calendar and ops assets from S3 or local storage.

Supports fallback: tries S3 first, falls back to local filesystem for dev/transition.
"""

import os
import json
import logging
from typing import Literal
from django.conf import settings
from services.storage import get_storage, S3Storage, LocalStorage

logger = logging.getLogger(__name__)


AssetType = Literal['calendar_styles', 'holidays', 'palettes', 'fonts']


class AssetNotFoundError(FileNotFoundError):
    """Raised when an asset cannot be found in either S3 or local storage."""
    pass


def read_asset(asset_type: AssetType, asset_name: str) -> bytes:
    """
    Read a calendar or ops asset from S3 or local storage.

    Args:
        asset_type: Type of asset ('calendar_styles', 'holidays', 'palettes', 'fonts')
        asset_name: Asset identifier, e.g., 'modern-minimalist', 'en-IN/2026', 'genz/vibrant'

    Returns:
        Raw bytes (typically JSON file content)

    Raises:
        AssetNotFoundError: If asset not found in S3 and local fallback missing

    S3 Key Format:
        s3://bucket/ops-config/{asset_type}/{asset_name}.json
        Example: s3://bucket/ops-config/calendar_styles/modern-minimalist.json
    """
    storage = get_storage()

    if isinstance(storage, S3Storage):
        return _read_from_s3(storage, asset_type, asset_name)
    else:
        return _read_from_local(asset_type, asset_name)


def _read_from_s3(storage: S3Storage, asset_type: AssetType, asset_name: str) -> bytes:
    """Read asset from S3 with local fallback for transition period."""
    s3_key = f"ops-config/{asset_type}/{asset_name}.json"

    try:
        return storage.read_calendar_asset(asset_type, asset_name)
    except Exception as exc:
        logger.warning(
            "S3 asset read failed: %s (%s); falling back to local storage",
            s3_key, exc
        )
        try:
            return _read_from_local(asset_type, asset_name)
        except Exception as local_exc:
            raise AssetNotFoundError(
                f"Asset not found: {asset_type}/{asset_name} "
                f"(S3 error: {exc}, local error: {local_exc})"
            ) from exc


def _read_from_local(asset_type: AssetType, asset_name: str) -> bytes:
    """Read asset from local filesystem."""
    asset_path = os.path.join(settings.STORAGE_ROOT, asset_type, f"{asset_name}.json")

    try:
        with open(asset_path, 'rb') as fh:
            return fh.read()
    except FileNotFoundError:
        raise AssetNotFoundError(
            f"Asset not found locally: {asset_type}/{asset_name}"
        ) from None
    except Exception as exc:
        logger.error(f"Error reading local asset {asset_path}: {exc}")
        raise AssetNotFoundError(f"Failed to read asset: {str(exc)}") from exc


def read_asset_json(asset_type: AssetType, asset_name: str) -> dict:
    """
    Read and parse a calendar asset as JSON.

    Args:
        asset_type: Type of asset
        asset_name: Asset identifier

    Returns:
        Parsed JSON object as dict

    Raises:
        AssetNotFoundError: If asset not found
        json.JSONDecodeError: If asset content is not valid JSON
    """
    content = read_asset(asset_type, asset_name)
    return json.loads(content.decode('utf-8'))


def list_assets_in_local_storage(asset_type: AssetType) -> list:
    """
    List all assets of a given type in local storage.
    Useful for ops UIs that populate dropdowns.

    Args:
        asset_type: Type of asset to list

    Returns:
        List of asset names (without .json extension)
    """
    asset_dir = os.path.join(settings.STORAGE_ROOT, asset_type)
    if not os.path.isdir(asset_dir):
        return []

    items = []
    try:
        for filename in os.listdir(asset_dir):
            if filename.endswith('.json'):
                items.append(os.path.splitext(filename)[0])
    except Exception as exc:
        logger.error(f"Error listing assets in {asset_dir}: {exc}")

    return sorted(items)
