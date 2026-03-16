import os
from typing import BinaryIO, List
from django.conf import settings

class StorageBackend:
    def save_upload(self, filename: str, content: BinaryIO) -> str:
        raise NotImplementedError
    def list_layouts(self) -> List[str]:
        raise NotImplementedError
    def exports_path(self, name: str) -> str:
        raise NotImplementedError
    def layouts_dir(self) -> str:
        raise NotImplementedError
    def masks_dir(self) -> str:
        raise NotImplementedError

class LocalStorage(StorageBackend):
    def save_upload(self, filename: str, content: BinaryIO) -> str:
        path = os.path.join(settings.UPLOADS_DIR, filename)
        with open(path, "wb") as out:
            chunk = content.read(8192)
            while chunk:
                out.write(chunk)
                chunk = content.read(8192)
            return path
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
        # Create masks directory under media root if it doesn't exist
        masks_path = os.path.join(os.path.dirname(settings.LAYOUTS_DIR), "masks")
        os.makedirs(masks_path, exist_ok=True)
        return masks_path

_storage_instance: StorageBackend | None = None

def get_storage() -> StorageBackend:
    global _storage_instance
    if _storage_instance is None:
        backend = os.getenv("STORAGE_BACKEND", "local")
        if backend == "local":
            _storage_instance = LocalStorage()
        else:
            _storage_instance = LocalStorage()
    return _storage_instance
