"""
Tests for services.google_fonts — text overlays print in the family the
editor previewed instead of always in Inter.

The editor's Font Family picker loads each family from Google Fonts, while
the print set every overlay in the bundled Inter, so a script font previewed
as script and printed as Inter. These pin: a non-Inter family really changes
the glyphs; the weight lands on the wght axis by tag; only families on the
ops fonts list are fetched, and only from Google's hosts; a fetched font is
cached durably in storage (S3 on prod); and a font we can't get stops the
render (which the task retries) rather than printing in Inter.

No network: Google is replaced by a fake that serves the Parisienne fixture
(services/tests/fixtures) or the bundled Inter Variable. No database.

Run stand-alone:
    docker-compose run --rm --entrypoint /opt/venv/bin/python backend -m services.tests.test_google_fonts
"""
from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "product_editor.settings")
os.environ.setdefault("DEBUG", "1")
django.setup()

from django.conf import settings
from PIL import Image, ImageDraw, ImageFont

from services import google_fonts as gf
from services import storage as storage_mod
from services.fonts import _FONT_PATH, get_font
from services.tests.fake_s3 import FakeClientError, S3Backend

PARISIENNE = (Path(__file__).parent / "fixtures" / "Parisienne-Regular.ttf").read_bytes()
INTER_VARIABLE = _FONT_PATH.read_bytes()
SAMPLE = "Happy Birthday"
SIZE = 60


def _css(url: str, weight: int = 400) -> bytes:
    return (
        "@font-face {\n  font-family: 'X';\n  font-style: normal;\n"
        f"  font-weight: {weight};\n  src: url({url}) format('truetype');\n}}\n"
    ).encode()


class FakeGoogle:
    """Serves css2 + gstatic from a dict of family -> {weight: bytes}."""

    def __init__(self, faces: dict[str, dict[int, bytes]]):
        self.faces = faces
        self.calls: list[str] = []
        self.error: Exception | None = None

    def __call__(self, url: str, max_bytes: int):
        self.calls.append(url)
        if self.error is not None:
            raise self.error
        if url.startswith(gf.CSS_URL):
            query = url.split("family=", 1)[1]
            family, _, wght = query.partition(":wght@")
            family = family.replace("%20", " ")
            weights = self.faces.get(family)
            if weights is None:
                return 400, b"Missing font family"
            weight = int(wght) if wght else min(weights)
            if weight not in weights:
                return 400, b"Missing font family"
            slug = family.lower().replace(" ", "")
            return 200, _css(f"https://fonts.gstatic.com/s/{slug}/v1/{weight}.ttf", weight)
        if url.startswith("https://fonts.gstatic.com/s/"):
            parts = url.split("/")
            slug, weight = parts[4], int(parts[-1].split(".")[0])
            for family, weights in self.faces.items():
                if family.lower().replace(" ", "") == slug:
                    return 200, weights[weight]
        return 404, b""

    def font_downloads(self) -> int:
        return sum(1 for c in self.calls if "fonts.gstatic.com" in c)


class Env:
    """Fake Google + an allowlist + a temp STORAGE_ROOT under local storage."""

    def __init__(self, faces=None, allowed=("Parisienne",)):
        self.google = FakeGoogle(faces if faces is not None else {"Parisienne": {400: PARISIENNE}})
        self.allowed = list(allowed)

    def __enter__(self):
        gf.clear_caches()
        self._prev = (gf.http_get, gf.allowed_families, settings.STORAGE_ROOT,
                      storage_mod._storage_instance)
        gf.http_get = self.google
        gf.allowed_families = lambda: self.allowed
        self.root = tempfile.mkdtemp(prefix="pe-fonts-")
        settings.STORAGE_ROOT = self.root
        storage_mod._storage_instance = storage_mod.LocalStorage()
        return self

    def __exit__(self, *exc):
        gf.http_get, gf.allowed_families, settings.STORAGE_ROOT, storage_mod._storage_instance = self._prev
        shutil.rmtree(self.root, ignore_errors=True)
        gf.clear_caches()


def _render(font) -> Image.Image:
    img = Image.new("L", (900, 140), 255)
    ImageDraw.Draw(img).text((10, 20), SAMPLE, font=font, fill=0)
    return img


def _ink(img: Image.Image) -> int:
    return sum(1 for px in img.getdata() if px < 128)


def _raises_unavailable(fn) -> gf.FontUnavailable:
    try:
        fn()
    except gf.FontUnavailable as exc:
        return exc
    raise AssertionError("expected FontUnavailable")


# ── Inter stays the default ─────────────────────────────────────────────────


def test_no_family_generics_and_inter_use_the_bundled_font():
    with Env() as env:
        for family in (None, "", "sans-serif", "serif", "monospace", "cursive", "Inter", " inter "):
            assert gf.get_overlay_font(family, SIZE) is get_font(SIZE), family
        assert env.google.calls == [], "the bundled font needs no fetch"


# ── A non-Inter family ──────────────────────────────────────────────────────


def test_non_inter_family_prints_different_glyphs():
    with Env():
        script = gf.get_overlay_font("Parisienne", SIZE)
    inter = get_font(SIZE)
    assert script.getname()[0] == "Parisienne", script.getname()
    assert script.getbbox(SAMPLE) != inter.getbbox(SAMPLE), "metrics should differ from Inter"
    assert script.getlength(SAMPLE) < inter.getlength(SAMPLE) * 0.9, (
        script.getlength(SAMPLE), inter.getlength(SAMPLE))
    assert list(_render(script).getdata()) != list(_render(inter).getdata())


def test_text_overlay_renders_in_its_family():
    from services.overlay_renderer import render_overlays

    def draw(family):
        canvas = Image.new("RGB", (900, 800), (255, 255, 255))
        render_overlays(canvas, [{
            "type": "text", "text": SAMPLE, "x": 50, "y": 50, "fontSize": 60,
            "color": "#000000", "fontFamily": family, "textAlign": "center", "rotation": 0,
        }], 900, 800)
        return canvas.convert("L")

    with Env():
        script, inter = draw("Parisienne"), draw("sans-serif")
    assert _ink(script) > 0
    assert list(script.getdata()) != list(inter.getdata()), "print must not fall back to Inter"


def test_fetches_the_requested_weight_from_google_hosts_only():
    with Env() as env:
        gf.get_overlay_font("Parisienne", SIZE)
    assert env.google.calls == [
        f"{gf.CSS_URL}?family=Parisienne:wght@400",
        "https://fonts.gstatic.com/s/parisienne/v1/400.ttf",
    ], env.google.calls


def test_family_with_spaces_is_url_encoded():
    with Env(faces={"Great Vibes": {400: PARISIENNE}}, allowed=["Great Vibes"]) as env:
        gf.get_overlay_font("Great  Vibes", SIZE)
    assert env.google.calls[0] == f"{gf.CSS_URL}?family=Great%20Vibes:wght@400", env.google.calls


def test_missing_weight_falls_back_to_the_familys_default_face():
    # Lobster-style: Google answers 400 for wght@700; the browser would draw 400.
    with Env() as env:
        font = gf.get_overlay_font("Parisienne", SIZE, weight=700)
    assert font.getname()[0] == "Parisienne"
    assert env.google.calls[:2] == [
        f"{gf.CSS_URL}?family=Parisienne:wght@700",
        f"{gf.CSS_URL}?family=Parisienne",
    ], env.google.calls


# ── Weight axis ─────────────────────────────────────────────────────────────


def test_weight_is_set_on_the_wght_axis_by_tag():
    # Inter Variable's fvar order is [opsz, wght]; serving it as a Google family
    # checks the downloaded-font path sets wght by tag, not position.
    faces = {"Test Variable": {400: INTER_VARIABLE, 700: INTER_VARIABLE}}
    with Env(faces=faces, allowed=["Test Variable"]):
        regular = gf.get_overlay_font("Test Variable", SIZE, weight=400)
        bold = gf.get_overlay_font("Test Variable", SIZE, weight=700)
    assert _ink(_render(bold)) > _ink(_render(regular)) * 1.2

    explicit = ImageFont.truetype(str(_FONT_PATH), size=SIZE)
    explicit.set_variation_by_axes([14.0, 700.0])
    assert list(_render(bold).getdata()) == list(_render(explicit).getdata()), (
        "700 must land on wght with opsz at its default")


def test_weight_snaps_to_the_nearest_hundred():
    with Env() as env:
        gf.get_overlay_font("Parisienne", SIZE, weight=400)
        gf.get_overlay_font("Parisienne", SIZE, weight=410)  # snaps to 400
        assert env.google.font_downloads() == 1
        assert gf.cache_name("Parisienne", 650) == "parisienne/700.ttf"


# ── Allowlist / SSRF ────────────────────────────────────────────────────────


def test_family_not_on_the_ops_list_is_not_fetched():
    with Env(allowed=["Roboto"]) as env:
        exc = _raises_unavailable(lambda: gf.get_overlay_font("Parisienne", SIZE))
    assert "not on the ops fonts list" in str(exc)
    assert env.google.calls == []


def test_allowlist_match_ignores_case_and_spacing():
    with Env(allowed=["  parisienne "]):
        assert gf.get_overlay_font("Parisienne", SIZE).getname()[0] == "Parisienne"


def test_malformed_family_names_are_refused_without_a_request():
    bad = ["../../etc/passwd", "Roboto&family=Evil", "http://169.254.169.254/", "A" * 65,
           "Roboto:wght@700", "Roboto/../x"]
    with Env(allowed=bad) as env:
        for family in bad:
            _raises_unavailable(lambda f=family: gf.get_overlay_font(f, SIZE))
    assert env.google.calls == []


def test_font_url_outside_gstatic_is_never_requested():
    with Env() as env:
        def evil(url, max_bytes):
            env.google.calls.append(url)
            return 200, _css("https://169.254.169.254/latest/meta-data.ttf")
        gf.http_get = evil
        exc = _raises_unavailable(lambda: gf.get_overlay_font("Parisienne", SIZE))
    assert "Refusing font URL" in str(exc)
    assert env.google.calls == [f"{gf.CSS_URL}?family=Parisienne:wght@400"]


def test_http_get_refuses_redirects_and_caps_the_body():
    import requests

    seen = {}

    class Resp:
        status_code = 200

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def iter_content(self, n):
            for _ in range(10):
                yield b"x" * 1000

    def fake_get(url, **kwargs):
        seen.update(kwargs)
        return Resp()

    prev = requests.get
    requests.get = fake_get
    try:
        _raises_unavailable(lambda: gf._http_get("https://fonts.gstatic.com/x.ttf", 5000))
        assert gf._http_get("https://fonts.gstatic.com/x.ttf", 20000) == (200, b"x" * 10000)
    finally:
        requests.get = prev
    assert seen["allow_redirects"] is False
    assert seen["timeout"] == gf.TIMEOUT


# ── Durable cache ───────────────────────────────────────────────────────────


def test_fetched_font_is_cached_in_storage_and_reused():
    with Env() as env:
        gf.get_overlay_font("Parisienne", SIZE)
        cached = Path(env.root, "font_cache", "parisienne", "400.ttf")
        assert cached.read_bytes() == PARISIENNE
        gf.clear_caches()  # a fresh worker process
        gf.get_overlay_font("Parisienne", SIZE + 4)
        assert env.google.font_downloads() == 1, env.google.calls


def test_cached_font_still_prints_after_ops_drop_it_from_the_list():
    with Env() as env:
        gf.get_overlay_font("Parisienne", SIZE)
        gf.clear_caches()
        env.allowed = []
        assert gf.get_overlay_font("Parisienne", SIZE).getname()[0] == "Parisienne"


def test_s3_cache_key_and_reuse():
    with Env() as env, S3Backend() as s3:
        gf.get_overlay_font("Parisienne", SIZE)
        key = "product-editor/font-cache/parisienne/400.ttf"
        assert s3.client.objects[key] == PARISIENNE
        assert s3.client.content_types[key] == "font/ttf"
        gf.clear_caches()
        gf.get_overlay_font("Parisienne", SIZE)
        assert env.google.font_downloads() == 1


def test_a_failed_cache_write_does_not_fail_the_print():
    with Env(), S3Backend() as s3:
        s3.client.put_error = FakeClientError("AccessDenied", 403)
        assert gf.get_overlay_font("Parisienne", SIZE).getname()[0] == "Parisienne"


def test_storage_rejects_bad_font_cache_names():
    with Env():
        for name in ("../x/400.ttf", "parisienne/400.otf", "a/b/400.ttf", "Parisienne/400.ttf"):
            try:
                storage_mod.get_storage().write_font_file(name, b"x")
            except ValueError:
                continue
            raise AssertionError(f"accepted {name!r}")


# ── Unavailable font ────────────────────────────────────────────────────────


def test_google_unreachable_is_font_unavailable():
    with Env() as env:
        env.google.error = ConnectionError("timed out")
        exc = _raises_unavailable(lambda: gf.get_overlay_font("Parisienne", SIZE))
    assert "unreachable" in str(exc)


def test_non_font_download_is_font_unavailable():
    with Env(faces={"Parisienne": {400: b"<html>captive portal</html>"}}):
        _raises_unavailable(lambda: gf.get_overlay_font("Parisienne", SIZE))


def test_s3_outage_on_the_cache_is_font_unavailable_not_a_refetch():
    with Env() as env, S3Backend() as s3:
        s3.client.get_error = FakeClientError("InternalError", 500)
        _raises_unavailable(lambda: gf.get_overlay_font("Parisienne", SIZE))
    assert env.google.calls == []


def test_fonts_list_outage_is_font_unavailable():
    from services.storage import CalendarAssetUnavailable

    def outage():
        raise CalendarAssetUnavailable("S3 down")

    with Env():
        prev = gf.allowed_families
        gf.allowed_families = gf._ops_fonts
        try:
            from services import asset_store
            real = asset_store.read_asset_json
            asset_store.read_asset_json = lambda *a: outage()
            try:
                _raises_unavailable(lambda: gf.get_overlay_font("Parisienne", SIZE))
            finally:
                asset_store.read_asset_json = real
        finally:
            gf.allowed_families = prev


def test_ops_fonts_list_is_the_default_allowlist():
    with Env() as env:
        gf.allowed_families = gf._ops_fonts
        Path(env.root, "fonts.json").write_text('["sans-serif", "Parisienne"]')
        assert gf.get_overlay_font("Parisienne", SIZE).getname()[0] == "Parisienne"


def test_render_overlays_and_engine_do_not_swallow_font_unavailable():
    from layout_engine.engine import LayoutEngine
    from services.overlay_renderer import render_overlays

    overlay = {"type": "text", "text": SAMPLE, "x": 50, "y": 50, "fontSize": 20,
               "color": "#000", "fontFamily": "Parisienne", "textAlign": "center"}
    with Env() as env:
        env.google.error = ConnectionError("down")
        _raises_unavailable(lambda: render_overlays(
            Image.new("RGB", (300, 300), "white"), [overlay], 300, 300))

        work = tempfile.mkdtemp(prefix="pe-fonts-eng-")
        photo = os.path.join(work, "white.png")
        Image.new("RGB", (300, 300), "white").save(photo)
        surface = {"canvas": {"width": 300, "height": 300, "widthMm": 300, "dpi": 300},
                   "frames": [{"x": 0, "y": 0, "width": 300, "height": 300}]}
        engine = LayoutEngine(os.path.join(work, "l"), os.path.join(work, "e"))
        _raises_unavailable(lambda: engine._composite_canvas(
            surface, [photo], "cover", None, frame_transforms=[{}], overlays=[overlay]))
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    import sys
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  ok   {t.__name__}")
        except Exception as exc:
            failed += 1
            print(f"  FAIL {t.__name__}: {exc!r}")
    print(f"{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
