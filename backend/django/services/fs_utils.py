"""Filesystem helpers shared by the GC sweeps (orphan_exports, chunk_staging)."""
from __future__ import annotations

import os
import uuid


def is_uuid(name: str) -> bool:
    try:
        uuid.UUID(name)
        return True
    except (ValueError, AttributeError, TypeError):
        return False


def dir_size_bytes(path: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for fname in files:
            try:
                total += os.path.getsize(os.path.join(root, fname))
            except OSError:
                continue
    return total
