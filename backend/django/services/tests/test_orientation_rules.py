"""
The pure rules behind POST /api/orientation/detect (services/orientation.py):
the cardinal dead zone, the face up-angle convention, how a quarter turn is
chosen from the face detector's per-turn results, and that the face detector
is consulted only when the pose model declines.

No mediapipe and no numpy: CI installs a mediapipe-stripped requirements
subset, and numpy only arrives with mediapipe. The per-turn tables below are
what the face detector measured on the browser's 640 px JPEG copy of real
customer photos on 2026-10-25; the expected turn is the one a person chose
after seeing the photo turned both ways (docs/HISTORY.md, "Auto-orientation").

Run stand-alone:
    cd backend/django && DEBUG=1 python -m services.tests.test_orientation_rules
"""
from __future__ import annotations

import os
import tempfile

import services.orientation as orientation
from services.orientation import (
    RotationSuggestion,
    _CARDINAL_DEAD_ZONE_DEG,
    _angle_to_rotation,
    _pick_face_frame,
    _up_angle,
    detect_rotation,
)


def test_dead_zone_is_twenty_degrees():
    # 15° missed a couple by a car at 74.4° (body-up pointing right); 30° once
    # turned a ~30° lean sideways. 20° is the measured middle.
    assert _CARDINAL_DEAD_ZONE_DEG == 20


def test_angles_inside_the_dead_zone_snap_to_the_cardinal():
    for angle in (0, 19, -19, 20, -20):
        assert _angle_to_rotation(angle) == 0, angle
    # Subject's up points right → turn anticlockwise (Fabric 270).
    for angle in (90, 74.4, 70, 110):
        assert _angle_to_rotation(angle) == 270, angle
    # Subject's up points left → turn clockwise (Fabric 90).
    for angle in (-90, -76.6, -70, -110):
        assert _angle_to_rotation(angle) == 90, angle
    for angle in (180, -180, 161, -161):
        assert _angle_to_rotation(angle) == 180, angle


def test_angles_between_cardinals_decline():
    for angle in (21, 45, 69, 111, 135, 159, -21, -69, -111, -159):
        assert _angle_to_rotation(angle) is None, angle


def test_face_up_angle_uses_the_pose_convention():
    # Eyes above the mouth: upright.
    assert abs(_up_angle((0.4, 0.4), (0.6, 0.4), (0.5, 0.6))) < 1e-9
    # Eyes to the RIGHT of the mouth: the face's up points right → anticlockwise turn.
    angle = _up_angle((0.7, 0.4), (0.7, 0.6), (0.5, 0.5))
    assert abs(angle - 90) < 1e-9 and _angle_to_rotation(angle) == 270
    # Eyes to the LEFT of the mouth → clockwise turn.
    angle = _up_angle((0.3, 0.4), (0.3, 0.6), (0.5, 0.5))
    assert abs(angle + 90) < 1e-9 and _angle_to_rotation(angle) == 90
    # Eyes below the mouth: upside down.
    angle = _up_angle((0.4, 0.6), (0.6, 0.6), (0.5, 0.4))
    assert abs(abs(angle) - 180) < 1e-9 and _angle_to_rotation(angle) == 180


# Best face per clockwise quarter turn, as (score, tilt°). The score of a
# sideways face is often within 0.05 of the upright one, which is why the
# rule picks by tilt and never by score.
MEASURED = [
    ("three friends at night, heads right",
     {0: [(0.71, 58)], 90: [(0.74, 6)], 180: [(0.74, -52)], 270: [(0.94, 13)]}, 270),
    ("selfie, heads left",
     {0: [(0.92, -85)], 90: [(0.98, 5)], 180: [(0.88, 82)], 270: [(0.59, 33)]}, 90),
    ("cheek to cheek behind a toy with a face",
     {0: [(0.66, 62)], 90: [(0.70, 25)], 180: [(0.92, -64)], 270: [(0.92, 19)]}, 270),
    ("man in a checked shirt, chin on hand",
     {0: [(0.86, 79)], 90: [(0.70, 7)], 180: [(0.81, -90)], 270: [(0.89, -15)]}, 270),
    ("selfie with heads tilted together",
     {0: [(0.88, -65)], 90: [(0.98, 20)], 180: [(0.89, 74)], 270: [(0.63, -29)]}, 90),
    ("upright portrait",
     {0: [(0.96, -4)], 90: [(0.95, 57)], 180: [(0.75, -52)], 270: [(0.80, -49)]}, 0),
    ("selfie, heads left, one face hidden",
     {0: [(0.93, -71)], 90: [(0.96, 0)], 180: [(0.91, 87)], 270: [(0.59, -34)]}, 90),
]


def test_measured_customer_photos_turn_the_right_way():
    for name, frames, expected in MEASURED:
        rotation, reason, score = _pick_face_frame(frames)
        assert rotation == expected, (name, rotation, reason)
        assert score >= 0.8, name


def test_no_face_or_only_weak_faces_declines():
    assert _pick_face_frame({0: [], 90: [], 180: [], 270: []})[0] is None
    assert _pick_face_frame({0: [(0.79, 0)], 90: [(0.7, 3)], 180: [], 270: []})[0] is None


def test_a_face_that_never_stands_upright_declines():
    # A head resting on a shoulder is ~30° off in every turn: don't guess.
    assert _pick_face_frame({0: [(0.9, 30)], 90: [(0.9, -60)], 180: [(0.9, 150)], 270: [(0.9, 120)]})[0] is None


def test_two_nearly_upright_turns_decline():
    # The detector finding an "upright" face in two turns (a toy's face, a
    # reflection) is ambiguous, even when one is a better fit.
    rotation, reason, _ = _pick_face_frame({0: [(0.9, 5)], 90: [(0.85, 40)], 180: [], 270: []})
    assert rotation is None and reason.startswith("ambiguous")
    # A second turn 46°+ off is not a rival.
    assert _pick_face_frame({0: [(0.9, 5)], 90: [(0.85, 46)], 180: [], 270: []})[0] == 0


def test_every_confident_face_in_the_chosen_turn_must_agree():
    assert _pick_face_frame({0: [], 90: [(0.95, 3), (0.9, 70)], 180: [], 270: []})[0] is None
    assert _pick_face_frame({0: [], 90: [(0.95, 3), (0.9, 30)], 180: [], 270: []})[0] == 90
    # A weak second face does not get a say.
    assert _pick_face_frame({0: [], 90: [(0.95, 3), (0.6, 70)], 180: [], 270: []})[0] == 90


def _tiny_jpeg() -> str:
    from PIL import Image
    fd, path = tempfile.mkstemp(suffix=".jpg")
    os.close(fd)
    Image.new("RGB", (8, 8), "white").save(path, "JPEG")
    return path


def test_face_detector_runs_only_when_the_pose_declines():
    calls = []
    saved = (orientation._get_landmarker, orientation._pose_rotation, orientation._face_rotation)
    path = _tiny_jpeg()
    try:
        orientation._get_landmarker = lambda: object()
        orientation._pose_rotation = lambda rgb, tag, lm: (
            calls.append("pose") or RotationSuggestion(90, 0.9, "pose-lite"))
        orientation._face_rotation = lambda rgb, tag: (
            calls.append("face") or RotationSuggestion(270, 0.9, "face-short"))
        got = detect_rotation(path, "x")
        assert got.rotation == 90 and got.source == "pose-lite" and calls == ["pose"]

        calls.clear()
        orientation._pose_rotation = lambda rgb, tag, lm: calls.append("pose")  # declines
        got = detect_rotation(path, "x")
        assert got.rotation == 270 and got.source == "face-short" and calls == ["pose", "face"]

        orientation._face_rotation = lambda rgb, tag: None
        assert detect_rotation(path, "x") is None
    finally:
        orientation._get_landmarker, orientation._pose_rotation, orientation._face_rotation = saved
        os.remove(path)


def test_no_pose_model_means_no_answer_at_all():
    # Mode off or mediapipe missing: nothing runs, not even the face detector,
    # and the file is never opened.
    saved = orientation._get_landmarker
    try:
        orientation._get_landmarker = lambda: None
        assert detect_rotation("/nonexistent/photo.jpg", "x") is None
    finally:
        orientation._get_landmarker = saved


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  ✓ {fn.__name__}")
    print(f"\n{len(fns)} orientation-rule tests passed.")
