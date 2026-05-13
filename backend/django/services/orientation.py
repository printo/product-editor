"""
Server-side auto-orientation detection via MediaPipe Pose Landmarker
(Apache 2.0, Google).

Why server-side: a customer on a slow phone shouldn't get worse rotation
correction than one on a fast laptop. Centralising the inference keeps the
result deterministic across devices and avoids shipping a multi-MB model
to every browser.

How it works:
  1. Load the image once (PIL → numpy → mediapipe.Image).
  2. Run PoseLandmarker on the un-rotated image.
  3. If pose found, take nose + shoulder-midpoint and compute the
     "body up" vector in image coordinates.
  4. Snap that vector to the nearest cardinal (0°, 90°, 180°, 270°)
     using a conservative dead-zone so ambiguous angles don't trigger
     unwanted rotation.

Returns a `RotationSuggestion` or `None` if no usable pose was detected,
in which case the frontend should fall back to its aspect-ratio
heuristic (`shouldAutoRotate90` in `editor/layout/[name]/page.tsx`).

Singleton model loader: the .task file is ~5–9 MB and the warm-up
takes ~1–2 s. We load it once per worker process and reuse.

Concurrency: thread-safe because each `.detect()` call is independent
and MediaPipe handles GIL release internally for the inference loop.
A single PoseLandmarker instance per process is the recommended pattern.
"""
from __future__ import annotations

import logging
import math
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# Resolved at first call so workers without the dep installed (e.g.
# the priority/standard render workers, which intentionally skip the
# mediapipe install) can still import this module without crashing.
_MP_LANDMARKER = None
_MP_LOAD_LOCK = threading.Lock()
_MP_LOAD_FAILED = False

# Conservative dead-zone (degrees) — only suggest rotation when we're
# confident. Angles near a 45° boundary (e.g. 40°) are ambiguous between
# 0 and 90; returning 0 ("don't rotate") is the safer default.
_CARDINAL_DEAD_ZONE_DEG = 30

# Landmark visibility threshold — discard the pose if either shoulder
# or the nose is occluded, since the body-up vector becomes unreliable.
_MIN_LANDMARK_VISIBILITY = 0.5

# MediaPipe Pose landmark indices (BlazePose's 33-keypoint topology).
# See https://developers.google.com/mediapipe/solutions/vision/pose_landmarker
_NOSE = 0
_LEFT_SHOULDER = 11
_RIGHT_SHOULDER = 12

_MODELS_DIR = Path(__file__).resolve().parent / "ml_models"


@dataclass
class RotationSuggestion:
    """Result of an orientation-detection inference."""

    # Degrees to rotate the image clockwise (Fabric.js convention) so that
    # the subject is upright. One of: 0, 90, 180, 270.
    rotation: int

    # Confidence of the underlying pose detection, used by the UI to
    # decide whether to display the "✨ Auto-rotated" badge. 0.0–1.0.
    confidence: float

    # Which model produced this — useful for debugging + logging.
    source: str  # "pose-lite" | "pose-full"


def _resolve_model_path() -> Optional[Path]:
    """Pick the model variant based on `AUTO_ORIENTATION_MODE` in settings."""
    try:
        from django.conf import settings
        mode = getattr(settings, "AUTO_ORIENTATION_MODE", "mediapipe")
    except Exception:
        # Allow running outside Django (tests / debug shells).
        mode = os.environ.get("AUTO_ORIENTATION_MODE", "mediapipe")

    if mode == "off":
        return None
    if mode == "hybrid":
        return _MODELS_DIR / "pose_landmarker_full.task"
    # default: mediapipe → lite (faster, suitable for 2-core boxes)
    return _MODELS_DIR / "pose_landmarker_lite.task"


def _get_landmarker():
    """Lazy-load the MediaPipe PoseLandmarker; returns None if unavailable."""
    global _MP_LANDMARKER, _MP_LOAD_FAILED

    if _MP_LOAD_FAILED:
        return None
    if _MP_LANDMARKER is not None:
        return _MP_LANDMARKER

    with _MP_LOAD_LOCK:
        if _MP_LANDMARKER is not None:
            return _MP_LANDMARKER
        if _MP_LOAD_FAILED:
            return None

        model_path = _resolve_model_path()
        if model_path is None:
            logger.info("Auto-orientation: mode=off, model not loaded")
            _MP_LOAD_FAILED = True
            return None
        if not model_path.exists():
            logger.error("Auto-orientation: model file missing at %s", model_path)
            _MP_LOAD_FAILED = True
            return None

        try:
            # Import inside the lock so a missing mediapipe install doesn't
            # tank every other Django request — the render workers
            # intentionally skip this install and that's fine.
            from mediapipe.tasks import python as mp_python  # type: ignore
            from mediapipe.tasks.python import vision as mp_vision  # type: ignore

            base_options = mp_python.BaseOptions(model_asset_path=str(model_path))
            options = mp_vision.PoseLandmarkerOptions(
                base_options=base_options,
                running_mode=mp_vision.RunningMode.IMAGE,
                num_poses=1,  # we only need one pose to determine orientation
                min_pose_detection_confidence=0.5,
                min_pose_presence_confidence=0.5,
                min_tracking_confidence=0.5,
                output_segmentation_masks=False,  # not needed, saves compute
            )
            _MP_LANDMARKER = mp_vision.PoseLandmarker.create_from_options(options)
            logger.info(
                "Auto-orientation: loaded MediaPipe PoseLandmarker from %s",
                model_path.name,
            )
        except ImportError:
            logger.warning(
                "Auto-orientation: mediapipe not installed; "
                "orientation detection disabled in this worker"
            )
            _MP_LOAD_FAILED = True
            return None
        except Exception as e:
            logger.exception("Auto-orientation: PoseLandmarker init failed: %s", e)
            _MP_LOAD_FAILED = True
            return None

    return _MP_LANDMARKER


def _angle_to_rotation(angle_deg: float) -> Optional[int]:
    """
    Snap the body-up angle to the nearest cardinal rotation (Fabric.js
    convention: positive = clockwise). Returns None when the angle falls
    inside the dead zone between two cardinals — we'd rather not rotate
    than rotate the wrong way.

    angle_deg = 0   → subject pointing up   → return 0
    angle_deg = +90 → subject pointing right (in image) → return 90 (CW)
    angle_deg = 180 → subject upside down   → return 180
    angle_deg = -90 → subject pointing left → return 270 (= -90 CW)
    """
    dz = _CARDINAL_DEAD_ZONE_DEG
    if -dz <= angle_deg <= dz:
        return 0
    if (90 - dz) <= angle_deg <= (90 + dz):
        return 90
    if angle_deg >= (180 - dz) or angle_deg <= -(180 - dz):
        return 180
    if -(90 + dz) <= angle_deg <= -(90 - dz):
        return 270
    return None  # ambiguous — caller treats as "no suggestion"


def detect_rotation(image_path: str) -> Optional[RotationSuggestion]:
    """
    Run PoseLandmarker on the given image and return a rotation suggestion,
    or None if no usable pose was detected. Safe to call from any worker
    process — model loading is lazy + cached + thread-safe.
    """
    landmarker = _get_landmarker()
    if landmarker is None:
        return None

    try:
        # PIL is already a backend dep; numpy comes with mediapipe.
        from PIL import Image, ImageOps  # type: ignore
        import numpy as np  # type: ignore
        import mediapipe as mp  # type: ignore
    except ImportError:
        return None

    try:
        with Image.open(image_path) as src:
            # Respect EXIF orientation BEFORE we ask the model — most JPEGs
            # in the wild are EXIF=1 anyway, but cameras sometimes flag
            # orientation, and we want the model to see the same "display
            # upright" view the customer expects to see.
            src = ImageOps.exif_transpose(src)
            rgb = src.convert("RGB")
            # MediaPipe expects RGB uint8 numpy array.
            arr = np.asarray(rgb, dtype=np.uint8)
    except Exception as e:
        logger.warning("Auto-orientation: failed to read %s: %s", image_path, e)
        return None

    try:
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=arr)
        result = landmarker.detect(mp_image)
    except Exception as e:
        logger.warning("Auto-orientation: detect() failed on %s: %s", image_path, e)
        return None

    if not result.pose_landmarks:
        # No person in this photo — orientation can't be determined from
        # pose. Caller falls back to the aspect-ratio heuristic.
        return None

    landmarks = result.pose_landmarks[0]
    nose = landmarks[_NOSE]
    left_sh = landmarks[_LEFT_SHOULDER]
    right_sh = landmarks[_RIGHT_SHOULDER]

    # Reject if any of the three is too low-visibility — the body-up
    # vector becomes unreliable when keypoints are occluded.
    if (
        nose.visibility < _MIN_LANDMARK_VISIBILITY
        or left_sh.visibility < _MIN_LANDMARK_VISIBILITY
        or right_sh.visibility < _MIN_LANDMARK_VISIBILITY
    ):
        return None

    # MediaPipe returns normalised [0, 1] coords with origin at image top-left
    # (y grows downward, x grows rightward). The body-up vector goes from
    # the shoulder midpoint to the nose; in image space that means
    # "less y" when the subject is upright.
    shoulder_mid_x = (left_sh.x + right_sh.x) / 2.0
    shoulder_mid_y = (left_sh.y + right_sh.y) / 2.0
    body_up_x = nose.x - shoulder_mid_x
    body_up_y = nose.y - shoulder_mid_y

    # atan2(image_right_component, image_up_component) — note we flip y so
    # "image up" (smaller y) becomes positive on our reference axis.
    angle_rad = math.atan2(body_up_x, -body_up_y)
    angle_deg = math.degrees(angle_rad)

    rotation = _angle_to_rotation(angle_deg)
    if rotation is None:
        # Subject's body-up vector is between cardinals (e.g. they're
        # photographed at a diagonal). Better to not rotate at all than
        # to rotate the wrong way.
        return None

    # Aggregate confidence: minimum of the three keypoint visibilities,
    # capped at the model's own pose-detection score from PoseLandmarker
    # (we don't get pose_detection_confidence in the IMAGE-mode result,
    # so we use visibility as a proxy).
    confidence = min(nose.visibility, left_sh.visibility, right_sh.visibility)

    # Source tag tracks which variant ran — handy in logs when comparing
    # `mediapipe` vs `hybrid` mode quality.
    try:
        from django.conf import settings
        source = "pose-full" if getattr(settings, "AUTO_ORIENTATION_MODE", "mediapipe") == "hybrid" else "pose-lite"
    except Exception:
        source = "pose-lite"

    return RotationSuggestion(
        rotation=rotation,
        confidence=float(confidence),
        source=source,
    )
