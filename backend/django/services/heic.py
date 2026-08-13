"""
Server-side HEIC/HEIF decoding for iPhone photos.

Why this exists on the server at all
------------------------------------
The editor converts HEIC to JPEG in the browser (``lib/heic-convert.ts``)
because neither the Fabric canvas nor the backend renderer can open HEIC.
That client path uses ``heic2any``, which bundles a **2021** build of libheif
and was last published in 2021.

Current iPhones (iOS 18) write a shape that decoder does not understand: the
primary item is a ``tmap`` *derived image* — Apple's ISO 21496-1 gain-map HDR —
whose actual pixels live in ``grid`` tiles. Confronted with a ``tmap`` primary
item the old decoder cannot resolve an image at all and fails. Safari can fall
back to Apple's system codec; **Chrome and Firefox ship no HEIC decoder**, so
for most desktop customers such a photo is simply unusable.

pillow-heif bundles a current libheif (1.19.x) which reads that structure
correctly, so this module is the backstop the browser cannot provide.

Colour management
-----------------
The embedded ICC profile is carried through onto the output JPEG rather than
being flattened here. Everything downstream already colour-manages via
``services/image_loader.open_source_rgba`` (ICC → sRGB at render time), so
converting early would either duplicate that work or, worse, silently drop the
Display-P3 profile these photos carry and shift the print's colours.

Orientation is NOT carried through. libheif applies the container's rotation
(``irot``/``imir``) while decoding, so the pixels handed back are already
upright; re-attaching the source EXIF would make ``exif_transpose`` downstream
rotate a second time. The output therefore has no EXIF block at all.
"""

from __future__ import annotations

import io
import logging

from django.conf import settings

logger = logging.getLogger(__name__)

#: JPEG quality for the converted image. This file is an intermediate — it is
#: re-uploaded and then rendered at 300 DPI — so it is kept high; the visible
#: cost of a second lossy generation is what we are guarding against, not size.
JPEG_QUALITY = 95


class HeicDecodeError(Exception):
    """Raised when the bytes are not decodable HEIC/HEIF."""


class HeicUnavailableError(Exception):
    """Raised when pillow-heif is not installed in this environment."""


def _open_heif(data: bytes):
    """Import pillow-heif lazily and open the payload.

    Deliberately NOT ``register_heif_opener()``: that patches Pillow globally
    for the whole process, which would silently change how every other
    ``Image.open`` in the codebase behaves. Opening explicitly keeps the effect
    local to this call.
    """
    try:
        import pillow_heif
    except ImportError as exc:  # pragma: no cover - depends on the image build
        raise HeicUnavailableError('pillow-heif is not installed') from exc

    try:
        return pillow_heif.open_heif(data, convert_hdr_to_8bit=True)
    except Exception as exc:
        raise HeicDecodeError(str(exc)) from exc


def decode_heic_to_jpeg(data: bytes) -> tuple[bytes, int, int]:
    """Decode HEIC/HEIF bytes to JPEG bytes.

    Returns ``(jpeg_bytes, width, height)``.

    Raises HeicUnavailableError if the decoder is missing, HeicDecodeError if
    the payload is not decodable or exceeds the configured dimension cap.
    """
    heif = _open_heif(data)

    width, height = heif.size
    # Same decompression-bomb ceiling the upload validator enforces, applied
    # BEFORE to_pillow() allocates the full RGB buffer — a hostile HEIC can
    # declare enormous dimensions in a few hundred bytes of header.
    max_dim = int(getattr(settings, 'MAX_IMAGE_DIMENSION_PX', 16384))
    if width > max_dim or height > max_dim:
        raise HeicDecodeError(
            f'Image is {width}x{height}px; the limit is {max_dim}px per side'
        )

    try:
        img = heif.to_pillow()
    except Exception as exc:
        raise HeicDecodeError(f'decode failed: {exc}') from exc

    try:
        icc_profile = img.info.get('icc_profile')
        if img.mode != 'RGB':
            img = img.convert('RGB')

        buf = io.BytesIO()
        save_kwargs = {'format': 'JPEG', 'quality': JPEG_QUALITY}
        if icc_profile:
            save_kwargs['icc_profile'] = icc_profile
        img.save(buf, **save_kwargs)
        return buf.getvalue(), width, height
    finally:
        img.close()
