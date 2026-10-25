"""
Server-side auto-orientation detection via MediaPipe (Apache 2.0, Google):
the Pose Landmarker first, and the bundled short-range face detector as a
second opinion when no usable pose is found.

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
  5. No usable pose (a close-up selfie crops the shoulders, a small subject
     collapses the keypoints): run the face detector on the photo at each
     quarter turn and answer with the turn in which the best face stands
     upright — see `_pick_face_frame`.

Returns a `RotationSuggestion` or `None` if neither detector gave a usable
answer, in which case the frontend falls back to its aspect-ratio
heuristic (`shouldAutoRotate90` in `editor/layout/[name]/editor-utils.ts`).

Singleton model loaders: the pose .task file is ~5–9 MB and the warm-up
takes ~1–2 s. We load it once per worker process and reuse. The face model
ships inside the mediapipe wheel (no download, no file in the repo).

Concurrency: PoseLandmarker is thread-safe because each `.detect()` call is
independent and MediaPipe handles GIL release internally for the inference
loop. A single PoseLandmarker instance per process is the recommended
pattern. The legacy face-detection solution is not documented thread-safe,
so its `.process()` runs under a lock (~15 ms per turn).
"""
from __future__ import annotations

import logging
import math
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# Resolved at first call so workers without the dep installed (e.g.
# the priority/standard render workers, which intentionally skip the
# mediapipe install) can still import this module without crashing.
_MP_LANDMARKER = None
_MP_LOAD_LOCK = threading.Lock()
_MP_LOAD_FAILED = False

# Cardinal window half-width (degrees). A pose's body-up angle must land
# within this many degrees of a cardinal (0/90/180/270) to trigger a
# rotation suggestion. Everything else returns None and the frontend
# falls back to the aspect-ratio heuristic.
#
# Tightened from 30° to 15° after the first prod rollout produced false
# positives on subjects with moderate body tilt (e.g. someone leaning
# while holding a pet — a ~30° body-axis tilt landed inside the old
# window and got "corrected" to sideways). Widened to 20° on 2026-10-25:
# a couple standing by a car read 74.4° (body-up pointing right) on the
# browser's 640 px JPEG copy, 0.6° outside the 15° window, and went in
# blind. 20° still keeps the ~30° lean that caused the false positives
# out; measured on 14 real customer photos with no new wrong answer
# (docs/HISTORY.md, "Auto-orientation").
_CARDINAL_DEAD_ZONE_DEG = 20

# Landmark visibility threshold — discard the pose entirely if either
# shoulder or the nose isn't confidently detected. Raised 0.5 → 0.7 after
# observing that low-visibility keypoints produced erratic body-up
# vectors and false rotations on partially-occluded subjects.
_MIN_LANDMARK_VISIBILITY = 0.7

# How far the shoulder line is allowed to be from perpendicular to the
# body-up vector. In an upright human, shoulders are horizontal and
# body-up is vertical (dot product = 0). Cameras at unusual angles or
# bad pose detection produce dot products further from zero; rejecting
# those eliminates a common class of false positive.
_MAX_NON_PERP_COS = 0.45  # ~63° away from perpendicular at most

# MediaPipe Pose landmark indices (BlazePose's 33-keypoint topology).
# See https://developers.google.com/mediapipe/solutions/vision/pose_landmarker
_NOSE = 0
_LEFT_SHOULDER = 11
_RIGHT_SHOULDER = 12

_MODELS_DIR = Path(__file__).resolve().parent / "ml_models"

# ---- Face second opinion ----------------------------------------------------
#
# Measured 2026-10-25 on 14 real customer photos (docs/HISTORY.md): the pose
# model read 5 of them, declining every close-up selfie (shoulders out of
# frame → "not perpendicular") and every small subject ("keypoints too
# close"). BlazeFace short-range, bundled with the mediapipe wheel, found
# the faces in 7. Its *score* is not an orientation signal — it rates a
# sideways face at 0.86–0.92 — but its eye/mouth keypoints are coherent
# only on an upright face, so the quarter turn in which the best face
# stands upright is the answer. Letting every turn vote was tried and
# rejected: keypoints on the three wrong turns are noise and outvote the
# right one.
_FACE_MIN_SCORE = 0.8          # a turn counts only with a face this confident
_FACE_MAX_TILT_DEG = 25        # the best face must stand this upright in the chosen turn
_FACE_AMBIGUOUS_TILT_DEG = 45  # a second turn this upright → decline
_FACE_AGREE_TILT_DEG = 40      # every confident face in the chosen turn must agree
_FACE_SOURCE = "face-short"

_FACE_DETECTOR = None
_FACE_LOAD_LOCK = threading.Lock()
_FACE_RUN_LOCK = threading.Lock()
_FACE_LOAD_FAILED = False

# BlazeFace keypoint order in the legacy solution's `relative_keypoints`.
_RIGHT_EYE = 0
_LEFT_EYE = 1
_MOUTH = 3


@dataclass
class RotationSuggestion:
    """Result of an orientation-detection inference."""

    # Degrees to rotate the image clockwise (Fabric.js convention) so that
    # the subject is upright. One of: 0, 90, 180, 270.
    rotation: int

    # Confidence of the underlying detection, used by the UI to decide
    # whether to display the "✨ Auto-rotated" badge. 0.0–1.0.
    confidence: float

    # Which model produced this — useful for debugging + logging.
    source: str  # "pose-lite" | "pose-full" | "face-short"


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


def _get_face_detector():
    """Lazy-load the bundled BlazeFace short-range detector; None if unavailable."""
    global _FACE_DETECTOR, _FACE_LOAD_FAILED

    if _FACE_LOAD_FAILED:
        return None
    if _FACE_DETECTOR is not None:
        return _FACE_DETECTOR

    with _FACE_LOAD_LOCK:
        if _FACE_DETECTOR is not None:
            return _FACE_DETECTOR
        if _FACE_LOAD_FAILED:
            return None
        try:
            import mediapipe as mp  # type: ignore

            _FACE_DETECTOR = mp.solutions.face_detection.FaceDetection(
                # Short range: faces within ~2 m, i.e. the selfies the pose
                # model drops. The full-range variant found nothing on the
                # same photos.
                model_selection=0,
                min_detection_confidence=0.5,
            )
            logger.info("Auto-orientation: loaded MediaPipe short-range face detector")
        except Exception as e:
            logger.warning("Auto-orientation: face detector unavailable (%s); pose only", e)
            _FACE_LOAD_FAILED = True
            return None

    return _FACE_DETECTOR


def _angle_to_rotation(angle_deg: float) -> Optional[int]:
    """
    Snap the body-up angle to the nearest cardinal rotation in Fabric.js
    convention (positive = clockwise). Returns None when the angle falls
    outside the tight window around each cardinal — caller treats that
    as "no confident suggestion" and falls back to the aspect heuristic.

    Convention:
      Image coords have y-down, x-right (top-left origin). A subject
      "upright in image" has nose ABOVE shoulders (smaller y). The
      angle is measured from "image up" with `atan2(body_up_x, -body_up_y)`
      so the cardinal mapping is:

        angle_deg ≈ 0    → subject upright          → rotate by 0   (no-op)
        angle_deg ≈ +90  → subject's up points → image-RIGHT
                            → rotate 90° CCW to upright → Fabric angle 270
        angle_deg ≈ ±180 → subject upside down      → rotate 180
        angle_deg ≈ -90  → subject's up points → image-LEFT
                            → rotate 90° CW to upright  → Fabric angle 90

    Direction was inverted in the initial v1.11 ship (90 and 270
    swapped) — fixed here after observing the baby photo rotate the
    wrong way on prod. Verify mentally: CW rotation moves "left" of
    the image to "top"; "left-pointing subject" therefore needs CW
    (Fabric angle = 90) to become upright.
    """
    dz = _CARDINAL_DEAD_ZONE_DEG
    if -dz <= angle_deg <= dz:
        return 0
    if (90 - dz) <= angle_deg <= (90 + dz):
        return 270  # subject points right → rotate CCW so right becomes top
    if angle_deg >= (180 - dz) or angle_deg <= -(180 - dz):
        return 180
    if -(90 + dz) <= angle_deg <= -(90 - dz):
        return 90   # subject points left → rotate CW so left becomes top
    return None  # ambiguous tilt — caller treats as "no suggestion"


def _up_angle(eye_a: Tuple[float, float], eye_b: Tuple[float, float], mouth: Tuple[float, float]) -> float:
    """
    Clockwise angle, in degrees from image-up, of a face's up vector (mouth →
    midpoint of the eyes); 0 means the face stands upright in this frame.
    Same convention as the pose model's body-up angle, so `_angle_to_rotation`
    applies unchanged.
    """
    eye_x = (eye_a[0] + eye_b[0]) / 2.0
    eye_y = (eye_a[1] + eye_b[1]) / 2.0
    return math.degrees(math.atan2(eye_x - mouth[0], -(eye_y - mouth[1])))


def _pick_face_frame(frames: Dict[int, List[Tuple[float, float]]]) -> Tuple[Optional[int], str, float]:
    """
    `frames` maps each clockwise quarter turn (0, 90, 180, 270) to the faces
    found after turning the photo that way, each as (score, tilt°) with tilt
    from `_up_angle` in the turned frame. Returns (rotation, reason, score):
    the turn in which the best face stands upright, or None when no turn is
    both confident and unambiguous. The detector's score only qualifies a
    face; it never chooses between turns.
    """
    candidates = []
    for turn, faces in frames.items():
        confident = [(score, tilt) for score, tilt in faces if score >= _FACE_MIN_SCORE]
        if not confident:
            continue
        score, tilt = max(confident, key=lambda face: face[0])
        candidates.append((abs(tilt), turn, score, tilt, confident))
    if not candidates:
        return None, "no confident face in any quarter turn", 0.0

    candidates.sort(key=lambda c: c[0])
    upright, turn, score, tilt, confident = candidates[0]
    if upright > _FACE_MAX_TILT_DEG:
        return None, f"best face still tilted {tilt:.0f}° after {turn}°", score
    runner_up = [c for c in candidates[1:] if c[0] <= _FACE_AMBIGUOUS_TILT_DEG]
    if runner_up:
        return (
            None,
            f"ambiguous: a face stands upright after {turn}° (tilt {tilt:.0f}°) "
            f"and after {runner_up[0][1]}° (tilt {runner_up[0][3]:.0f}°)",
            score,
        )
    if any(abs(face_tilt) > _FACE_AGREE_TILT_DEG for _, face_tilt in confident):
        return None, f"faces disagree after {turn}°", score
    return turn, f"face upright after {turn}° (tilt {tilt:.0f}°, {len(confident)} face(s))", score


def _face_rotation(rgb, tag: str) -> Optional[RotationSuggestion]:
    """
    Second opinion from the face detector: try the photo at each quarter
    turn and keep the one in which the best face stands upright. `rgb` is
    the EXIF-upright PIL image the pose model saw.
    """
    detector = _get_face_detector()
    if detector is None:
        return None
    try:
        import numpy as np  # type: ignore
    except ImportError:
        return None

    frames: Dict[int, List[Tuple[float, float]]] = {}
    try:
        for turn in (0, 90, 180, 270):
            # PIL rotates counter-clockwise for a positive angle; `turn` is
            # Fabric's clockwise angle, the one the editor would apply.
            turned = rgb if turn == 0 else rgb.rotate(-turn, expand=True)
            arr = np.ascontiguousarray(np.asarray(turned, dtype=np.uint8))
            with _FACE_RUN_LOCK:
                result = detector.process(arr)
            faces: List[Tuple[float, float]] = []
            for det in (result.detections or []):
                kp = det.location_data.relative_keypoints
                tilt = _up_angle(
                    (kp[_RIGHT_EYE].x, kp[_RIGHT_EYE].y),
                    (kp[_LEFT_EYE].x, kp[_LEFT_EYE].y),
                    (kp[_MOUTH].x, kp[_MOUTH].y),
                )
                faces.append((float(det.score[0]), tilt))
            frames[turn] = faces
    except Exception as e:
        logger.warning("[orientation] %s: face detector raised: %s", tag, e)
        return None

    rotation, reason, score = _pick_face_frame(frames)
    if rotation is None:
        logger.info("[orientation] %s: declined — %s", tag, reason)
        return None
    logger.info(
        "[orientation] %s: rotation=%d confidence=%.3f source=%s (%s)",
        tag, rotation, score, _FACE_SOURCE, reason,
    )
    return RotationSuggestion(rotation=rotation, confidence=score, source=_FACE_SOURCE)


def _pose_rotation(rgb, tag: str, landmarker) -> Optional[RotationSuggestion]:
    """Run PoseLandmarker on the EXIF-upright PIL image; None when no usable pose."""
    try:
        import numpy as np  # type: ignore
        import mediapipe as mp  # type: ignore
    except ImportError:
        logger.info("[orientation] %s: declined — mediapipe/PIL import failed", tag)
        return None

    try:
        # MediaPipe expects RGB uint8 numpy array.
        arr = np.asarray(rgb, dtype=np.uint8)
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=arr)
        result = landmarker.detect(mp_image)
    except Exception as e:
        logger.warning("[orientation] %s: declined — detect() raised: %s", tag, e)
        return None

    if not result.pose_landmarks:
        # No person in this photo — orientation can't be determined from
        # pose. The face detector gets a turn next, then the caller falls
        # back to the aspect-ratio heuristic.
        logger.info("[orientation] %s: declined — no pose detected", tag)
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
        logger.info(
            "[orientation] %s: declined — low visibility (nose=%.2f lsh=%.2f rsh=%.2f, need >=%.2f)",
            tag, nose.visibility, left_sh.visibility, right_sh.visibility, _MIN_LANDMARK_VISIBILITY,
        )
        return None

    # MediaPipe returns normalised [0, 1] coords with origin at image top-left
    # (y grows downward, x grows rightward). The body-up vector goes from
    # the shoulder midpoint to the nose; in image space that means
    # "less y" when the subject is upright.
    shoulder_mid_x = (left_sh.x + right_sh.x) / 2.0
    shoulder_mid_y = (left_sh.y + right_sh.y) / 2.0
    body_up_x = nose.x - shoulder_mid_x
    body_up_y = nose.y - shoulder_mid_y

    # Shoulder line (right minus left in image space).
    shoulder_x = right_sh.x - left_sh.x
    shoulder_y = right_sh.y - left_sh.y

    body_up_len = math.hypot(body_up_x, body_up_y)
    shoulder_len = math.hypot(shoulder_x, shoulder_y)

    # Reject poses where keypoints are too close together (subject very
    # small, or detection collapsed several keypoints into a single
    # point). 5% of normalised coords ≈ 5% of image diagonal — anything
    # smaller is unreliable.
    if body_up_len < 0.05 or shoulder_len < 0.05:
        logger.info(
            "[orientation] %s: declined — keypoints too close (body_up_len=%.3f shoulder_len=%.3f, need >=0.05)",
            tag, body_up_len, shoulder_len,
        )
        return None

    # Sanity check: in an upright human the shoulder line is roughly
    # perpendicular to the body-up vector. If the dot product of their
    # unit vectors is far from 0, the pose is suspect (e.g. one shoulder
    # mis-detected, or the subject is twisted at an unusual angle).
    # Reject rather than risk a wrong rotation. cos(63°) ≈ 0.45.
    dot = (body_up_x * shoulder_x + body_up_y * shoulder_y) / (body_up_len * shoulder_len)
    if abs(dot) > _MAX_NON_PERP_COS:
        logger.info(
            "[orientation] %s: declined — shoulders not perpendicular to body-up (|dot|=%.2f, max %.2f)",
            tag, abs(dot), _MAX_NON_PERP_COS,
        )
        return None

    # atan2(image_right_component, image_up_component) — note we flip y so
    # "image up" (smaller y) becomes positive on our reference axis.
    angle_rad = math.atan2(body_up_x, -body_up_y)
    angle_deg = math.degrees(angle_rad)

    rotation = _angle_to_rotation(angle_deg)
    if rotation is None:
        # Subject's body-up vector is between cardinals (e.g. they're
        # photographed at a diagonal). Better to not rotate at all than
        # to rotate the wrong way.
        logger.info(
            "[orientation] %s: declined — ambiguous angle %.1f° (no cardinal within %d° dead-zone)",
            tag, angle_deg, _CARDINAL_DEAD_ZONE_DEG,
        )
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

    logger.info(
        "[orientation] %s: rotation=%d confidence=%.3f angle=%.1f° source=%s",
        tag, rotation, float(confidence), angle_deg, source,
    )
    return RotationSuggestion(
        rotation=rotation,
        confidence=float(confidence),
        source=source,
    )


def detect_rotation(image_path: str, label: str = "") -> Optional[RotationSuggestion]:
    """
    Run the pose model, then the face detector when it declines, and return
    a rotation suggestion, or None if neither found anything usable. Safe to
    call from any worker process — model loading is lazy + cached + thread-safe.

    `label` is a human-readable tag (the uploaded filename) used only for
    log lines. Every decision branch logs at INFO with an `[orientation]`
    prefix so the exact reason a photo did / didn't get a rotation is
    visible in `docker compose logs backend`. This is the diagnostic the
    ops team's "Classic doesn't rotate" report needs — read the logs
    after a re-test to see per-photo what the model decided.
    """
    tag = label or image_path

    landmarker = _get_landmarker()
    if landmarker is None:
        logger.info("[orientation] %s: declined — model unavailable (mode off / load failed)", tag)
        return None

    try:
        # PIL is already a backend dep; numpy comes with mediapipe.
        from PIL import Image, ImageOps  # type: ignore
    except ImportError:
        logger.info("[orientation] %s: declined — PIL import failed", tag)
        return None

    try:
        with Image.open(image_path) as src:
            # Respect EXIF orientation BEFORE we ask the model — most JPEGs
            # in the wild are EXIF=1 anyway, but cameras sometimes flag
            # orientation, and we want the model to see the same "display
            # upright" view the customer expects to see.
            src = ImageOps.exif_transpose(src)
            rgb = src.convert("RGB")
    except Exception as e:
        logger.warning("[orientation] %s: declined — failed to read image: %s", tag, e)
        return None

    suggestion = _pose_rotation(rgb, tag, landmarker)
    if suggestion is not None:
        return suggestion
    return _face_rotation(rgb, tag)
