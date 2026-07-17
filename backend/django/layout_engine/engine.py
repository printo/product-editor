import gc
import json
import math
import os
import re
import tempfile
import logging
from typing import List, Optional

from PIL import Image, ImageOps, ImageDraw, ImageChops, ImageFilter

from services.image_loader import open_source_rgba, srgb_profile_bytes

logger = logging.getLogger(__name__)


# Filesystem-unsafe characters across macOS/Linux/Windows + the NULL byte.
# Spaces are explicitly KEPT per PRD §11.6 — example filenames are
# "January 2026.png", "February 2026.png", etc. Sanitization replaces unsafe
# chars with underscore so the displayLabel still reads naturally.
_FS_UNSAFE = re.compile(r'[\x00-\x1f<>:"/\\|?*]+')


def _sanitize_for_filename(name: str) -> str:
    """Replace filesystem-unsafe characters in a label; trim & collapse spaces."""
    if not name:
        return ""
    cleaned = _FS_UNSAFE.sub("_", name)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" ._")
    return cleaned

# Decompression-bomb guard. PIL warns at 178M pixels by default and refuses
# above 2× that. Photo prints can legitimately approach the warn threshold (a
# 50 MP smartphone shot is ~50M pixels), so we lift the ceiling but keep one
# in place — uncapped would let a crafted image OOM the worker. 500M pixels =
# a 22000×22000 image, ~6× the largest legitimate Printo upload.
Image.MAX_IMAGE_PIXELS = 500_000_000


class LayoutEngine:
    def __init__(self, layouts_dir: str, exports_dir: str):
        self.layouts_dir = layouts_dir
        self.exports_dir = exports_dir
        os.makedirs(self.exports_dir, exist_ok=True)

    # ── Atomic file write helper ─────────────────────────────────────────────

    def _write_output_atomic(self, image_data, output_path: str) -> str:
        """
        Write image data to disk atomically using .tmp → rename pattern.
        
        This ensures that downstream services never see partial/corrupted files.
        The temporary file is written in the same directory as the final file
        to guarantee the atomic move operation works on the same filesystem.
        
        Args:
            image_data: PIL Image object to save
            output_path: Final destination path
            
        Returns:
            Final output path after atomic move
        """
        output_dir = os.path.dirname(output_path)
        output_filename = os.path.basename(output_path)
        
        # Create temporary file in same directory (same filesystem)
        tmp_fd, tmp_path = tempfile.mkstemp(
            suffix='.tmp',
            prefix=f'.{output_filename}.',
            dir=output_dir
        )
        
        try:
            # Close the file descriptor as PIL will open the file itself
            os.close(tmp_fd)
            
            # Write to temporary file
            if hasattr(image_data, 'save'):
                # PIL Image - extract format from output_path extension
                ext = os.path.splitext(output_path)[1].lower()
                if ext == '.pdf':
                    # PIL writes one-image PDFs natively. resolution is in DPI;
                    # PDFs don't carry pixel-DPI metadata the way PNGs do, so
                    # callers should set the canvas size in points to match.
                    image_data.save(tmp_path, "PDF", resolution=300.0)
                elif ext == '.png':
                    # Tag the output as explicitly sRGB so the print RIP never
                    # has to guess the colour space (sources are converted to
                    # sRGB at load — see services/image_loader.py).
                    image_data.save(
                        tmp_path, "PNG", dpi=(300, 300),
                        icc_profile=srgb_profile_bytes(),
                    )
                else:
                    image_data.save(tmp_path)
            else:
                # Raw bytes
                with open(tmp_path, 'wb') as f:
                    f.write(image_data)
            
            # Set group-writable permissions (0664)
            os.chmod(tmp_path, 0o664)
            
            tmp_size = os.path.getsize(tmp_path)
            logger.info(f"Wrote temporary file: {tmp_path} ({tmp_size} bytes)")
            
            # Atomic move (same filesystem guaranteed)
            os.replace(tmp_path, output_path)

            final_size = os.path.getsize(output_path)
            logger.info(f"Atomic write completed: {output_path} ({final_size} bytes)")

            # ── Mock JPEG sibling — fast download-time bundling ──────────────
            # The download ZIP packages a `2_mock/` folder with web-friendly
            # previews of every print file. Generating those at download
            # time recomputes the same downscale on every click. Doing it
            # here while the PIL Image is still in memory is essentially
            # free (~30–80 ms per canvas) and means the download view just
            # bundles existing files. PDFs skip — PIL can't open them; the
            # 3_print/ original is the proof for those.
            if hasattr(image_data, 'save') and ext == '.png':
                try:
                    mock_path = os.path.splitext(output_path)[0] + '_preview.jpg'
                    rgb = image_data.convert('RGB')
                    # 600 px long-edge @ q=70 — good for email/web preview.
                    # Tightened from 800/q=80: ~50 % smaller mock files (~30 KB
                    # vs ~70 KB for a typical 4×6) with no perceptible loss
                    # at the size the ops team actually views these at.
                    rgb.thumbnail((600, 600), Image.Resampling.LANCZOS)
                    rgb.save(mock_path, format='JPEG', quality=70)
                    rgb.close()
                except Exception as mock_exc:
                    logger.warning(
                        "Mock JPEG generation failed for %s: %s",
                        output_path, mock_exc,
                    )

            return output_path
            
        except Exception as exc:
            # Clean up temporary file on failure
            try:
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
                    logger.info(f"Cleaned up temporary file after failure: {tmp_path}")
            except Exception as cleanup_exc:
                logger.warning(f"Failed to clean up temporary file {tmp_path}: {cleanup_exc}")
            logger.error(f"Atomic write failed for {output_path}: {exc}")
            raise

    # ── Layout / mask helpers ────────────────────────────────────────────────

    def _load_layout(self, name: str):
        path = os.path.join(self.layouts_dir, f"{name}.json")
        with open(path, "r") as f:
            return json.load(f)

    def _grid_frames(self, width: int, height: int, rows: int, cols: int, padding: int):
        frames = []
        cell_w = (width - (cols + 1) * padding) // cols
        cell_h = (height - (rows + 1) * padding) // rows
        for r in range(rows):
            for c in range(cols):
                x = padding + c * (cell_w + padding)
                y = padding + r * (cell_h + padding)
                frames.append({"x": x, "y": y, "width": cell_w, "height": cell_h})
        return frames

    def _load_mask(self, mask_url: str):
        """Load a mask image from its URL path, or return None."""
        if not mask_url:
            return None
        try:
            mask_filename = os.path.basename(mask_url)
            mask_path = os.path.join(os.path.dirname(self.layouts_dir), "masks", mask_filename)
            if os.path.exists(mask_path):
                return Image.open(mask_path).convert("RGBA")
        except Exception as exc:
            logger.warning("Failed to load mask '%s': %s", mask_url, exc)
        return None

    @staticmethod
    def _normalize_frames(frames: list, canvas_w: int, canvas_h: int) -> list:
        """
        Convert normalized (0–1) frame coordinates to pixels.

        JSON-defined layouts (e.g. retro_polaroid) store frame x/y/width/height
        as fractions of the canvas size (e.g. width=0.9 means 90% of canvas width).
        Grid frames generated by _grid_frames already return pixel values and are
        left unchanged.

        Detection: a frame is fractional when width ≤ 1.0 OR when it carries an
        'xMm' key (present on all JSON-authored layouts).
        """
        if not frames:
            return frames
        if any("xMm" in f or f.get("width", 999) <= 1.0 for f in frames):
            return [
                {
                    **f,
                    "x": round(f["x"] * canvas_w),
                    "y": round(f["y"] * canvas_h),
                    "width": round(f["width"] * canvas_w),
                    "height": round(f["height"] * canvas_h),
                }
                for f in frames
            ]
        return frames

    def _resolve_surface_def(self, layout: dict) -> dict:
        """Extract a single-surface definition from a legacy (non-product) layout JSON."""
        surface_def = {
            "canvas": layout["canvas"],
            "frames": layout.get("frames"),
            "maskUrl": layout.get("maskUrl"),
            "maskOnExport": layout.get("maskOnExport", False),
        }
        padding = layout.get("grid", {}).get("padding", 10)
        rows = layout.get("grid", {}).get("rows")
        cols = layout.get("grid", {}).get("cols")
        if surface_def["frames"] is None and rows and cols:
            surface_def["frames"] = self._grid_frames(
                layout["canvas"]["width"], layout["canvas"]["height"], rows, cols, padding
            )
        if not surface_def["frames"]:
            raise ValueError("No frames defined for layout")
        canvas_w = layout["canvas"]["width"]
        canvas_h = layout["canvas"]["height"]
        surface_def["frames"] = self._normalize_frames(surface_def["frames"], canvas_w, canvas_h)
        return surface_def

    # ── Core compositing ─────────────────────────────────────────────────────

    @staticmethod
    def _smart_downscale(img: Image.Image, target_w: int, target_h: int) -> Image.Image:
        """
        Pre-shrink source image to 2× the frame dimensions before compositing.

        A 12 MP photo (4000×3000) composited into a 400×400 frame has 100× more
        pixels than needed.  Downscaling to 2× the frame size (800×800) first
        reduces Pillow's resize work by ~50× with no perceptible quality loss —
        Lanczos is still applied for the final cover/contain resize.
        """
        max_w = target_w * 2
        max_h = target_h * 2
        if img.width > max_w or img.height > max_h:
            # `img` is a freshly-converted RGBA copy held only by the caller
            # (`_composite_canvas` reassigns: `img = self._smart_downscale(img, …)`),
            # so we can mutate it in place. Skipping the prior defensive
            # `img.copy()` saves a ~50 MB memcpy per 12 MP frame; over a
            # 200-canvas batch that's tens of GB of memory bandwidth.
            #
            # BOX averaging is 5–10× faster than LANCZOS and quality-
            # equivalent for downscales > 2×; the cover/contain LANCZOS resize
            # later still produces high-quality output.
            img.thumbnail((max_w, max_h), Image.Resampling.BOX)
        return img

    @staticmethod
    def _parse_hex_color(value, default=(255, 255, 255)) -> tuple:
        """
        Parse '#rrggbb' / '#rgb' / 'rrggbb' into an (r, g, b) tuple. Falls back
        to `default` (white) on None / blank / malformed input, so a bad colour
        never crashes a render.
        """
        if not value or not isinstance(value, str):
            return default
        s = value.strip().lstrip("#")
        try:
            if len(s) == 3:
                s = "".join(c * 2 for c in s)
            if len(s) != 6:
                return default
            return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))
        except ValueError:
            return default

    @staticmethod
    def _frame_corner_radius(frame: dict, surface_def: dict) -> float:
        """
        Corner radius in px for a frame, matching the browser preview exactly
        (fabric-renderer.ts): min(w/2, h/2, borderRadiusMm * pxPerMm), where
        pxPerMm = canvas_width_px / canvas_width_mm (falls back to dpi / 25.4).
        Returns 0 for square frames (borderRadiusMm 0/absent). Shared by the
        frame shape mask and the paper-mat hole punch so the two never diverge.
        """
        border_mm = float(frame.get("borderRadiusMm") or 0)
        if border_mm <= 0:
            return 0.0
        w = frame.get("width") or 0
        h = frame.get("height") or 0
        if w <= 0 or h <= 0:
            return 0.0
        canvas = surface_def.get("canvas", {}) or {}
        canvas_w_px = canvas.get("width") or w
        canvas_w_mm = canvas.get("widthMm")
        if canvas_w_mm:
            px_per_mm = canvas_w_px / canvas_w_mm
        else:
            px_per_mm = (canvas.get("dpi") or 300) / 25.4
        return max(0.0, min(w / 2.0, h / 2.0, border_mm * px_per_mm))

    @staticmethod
    def _apply_frame_shape_mask(layer: Image.Image, frame: dict, surface_def: dict) -> None:
        """
        Clip a frame-sized RGBA layer in place to the frame's rounded/circular
        shape, so circle/rounded products print in shape (e.g. circle_48mm
        magnets) instead of as white-cornered squares. No-op for square frames.
        The rounded-rect alpha mask is intersected with the layer's existing
        alpha (multiply), so already-transparent image regions stay transparent.
        """
        radius = LayoutEngine._frame_corner_radius(frame, surface_def)
        if radius <= 0:
            return
        w, h = layer.size
        mask = Image.new("L", (w, h), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            [0, 0, w - 1, h - 1], radius=radius, fill=255,
        )
        alpha = ImageChops.multiply(layer.getchannel("A"), mask)
        layer.putalpha(alpha)
        mask.close()

    def _render_paper_mat(self, canvas: Image.Image, frames: list, surface_def: dict, paper_rgb: tuple) -> None:
        """
        Paint the customer's paper/mat colour over the whole canvas EXCEPT the
        frame holes (matching the browser paper overlay, fabric-renderer.ts), so
        the mat surrounds the frames and the photos show through. Holes honour
        each frame's rounded/circular shape via the shared radius helper.
        """
        w, h = canvas.size
        holes = Image.new("L", (w, h), 255)  # opaque mat everywhere ...
        draw = ImageDraw.Draw(holes)
        for frame in frames:
            fx = int(frame.get("x") or 0)
            fy = int(frame.get("y") or 0)
            fw = int(frame.get("width") or 0)
            fh = int(frame.get("height") or 0)
            if fw <= 0 or fh <= 0:
                continue
            box = [fx, fy, fx + fw - 1, fy + fh - 1]
            radius = self._frame_corner_radius(frame, surface_def)
            if radius > 0:
                draw.rounded_rectangle(box, radius=radius, fill=0)  # ... punch a hole
            else:
                draw.rectangle(box, fill=0)
        mat = Image.new("RGBA", (w, h), (*paper_rgb, 255))
        mat.putalpha(holes)  # transparent inside the frame holes
        canvas.paste(mat, (0, 0), mat)
        holes.close()
        mat.close()

    def _paint_frame_fill(
        self,
        layer: Image.Image,
        img: Image.Image,
        fill_style: str,
        target_w: int,
        target_h: int,
        paper_color: Optional[str],
    ) -> None:
        """
        Paint a contain-mode fill behind the photo, covering the whitespace a
        contained image leaves inside the frame. Mirrors the two styles in
        fabric-renderer.ts / frame-display.py getFrameFillBehavior:
          'border' → solid paper colour (the customer's mat colour, else white)
          'blur'   → the photo stretched to the frame box then Gaussian-blurred

        `layer` is the frame-sized RGBA buffer; the caller pastes the sharp,
        correctly-fitted photo on top afterwards.
        """
        if fill_style == 'border':
            fill_rgb = self._parse_hex_color(paper_color) if paper_color else (255, 255, 255)
            fill_img = Image.new("RGBA", (target_w, target_h), (*fill_rgb, 255))
            layer.paste(fill_img, (0, 0))
            fill_img.close()
            return

        # 'blur' (default): stretch the source to the frame box — matching the
        # preview's drawImage(el, 0, 0, fw, fh) — then blur. Aspect distortion is
        # invisible under blur and keeps the fill edge-to-edge like the editor.
        bg = img.resize((target_w, target_h), Image.Resampling.LANCZOS)
        radius = max(8, int(min(target_w, target_h) * 0.03))
        bg = bg.filter(ImageFilter.GaussianBlur(radius))
        bg.putalpha(255)
        layer.paste(bg, (0, 0))
        bg.close()

    def _draw_frame_caption(
        self,
        layer: Image.Image,
        text: str,
        target_w: int,
        target_h: int,
    ) -> None:
        """
        Draw a centred caption near the bottom of the frame, above the photo.
        Sizing / position mirror the Textbox in fabric-renderer.ts: font ≈ 4% of
        frame height, vertical centre ≈ 8% up from the bottom, wrapped to 80% of
        the frame width, colour #2a2a2a. Called inside the frame layer so the
        caption is clipped to the frame shape, same as the preview's clipPath.
        """
        from services.fonts import get_font

        font_px = max(8, int(target_h * 0.04))
        font = get_font(font_px, weight=400)
        max_w = max(1, int(target_w * 0.8))
        lines = self._wrap_caption_lines(text, font, max_w)
        if not lines:
            return

        line_h = int(font_px * 1.25)
        center_y = target_h - int(target_h * 0.08)
        start_y = center_y - (line_h * len(lines)) // 2 + line_h // 2
        cx = target_w // 2

        draw = ImageDraw.Draw(layer)
        for i, line in enumerate(lines):
            draw.text((cx, start_y + i * line_h), line, font=font, fill=(42, 42, 42, 255), anchor="mm")

    @staticmethod
    def _wrap_caption_lines(text: str, font, max_w: int) -> List[str]:
        """Greedy word-wrap so each line's rendered width stays within max_w."""
        words = text.split()
        if not words:
            return []
        lines: List[str] = []
        cur = words[0]
        for word in words[1:]:
            trial = f"{cur} {word}"
            if font.getlength(trial) <= max_w:
                cur = trial
            else:
                lines.append(cur)
                cur = word
        lines.append(cur)
        return lines

    @staticmethod
    def _resolve_caption_box(fx, fy, fw, fh, frame: dict, px_per_mm: float) -> dict:
        """
        Resolve an explicitly-placed caption's box (px, top-left origin) from the
        layout frame's caption* mm fields, filling any unset field with the same
        defaults as the browser (see frontend/src/lib/caption-layout.ts →
        resolveCaptionBox) so print == preview. Kept in lockstep by
        services/tests/test_caption_layout.py.
        """
        def mm(key):
            v = frame.get(key)
            if v is None or v == "":
                return None
            try:
                return float(v) * px_per_mm
            except (TypeError, ValueError):
                return None

        w = mm("captionWidthMm")
        if w is None:
            w = fw * 0.8
        font_px = mm("captionFontMm")
        if font_px is None:
            font_px = fh * 0.04
        x = mm("captionXMm")
        if x is None:
            x = fx + (fw - w) / 2
        y = mm("captionYMm")
        if y is None:
            y = fy + fh - fh * 0.08 - font_px / 2
        align = frame.get("captionAlign") or "center"
        color = frame.get("captionColor") or "#2a2a2a"
        return {"x": x, "y": y, "w": w, "font_px": max(1, int(round(font_px))), "align": align, "color": color}

    def _draw_caption_box(self, canvas: Image.Image, text: str, box: dict) -> None:
        """Draw an explicitly-placed caption on the full canvas (unclipped), wrapped
        to the box width and aligned. Mirrors the browser Textbox placement."""
        from services.fonts import get_font

        font = get_font(box["font_px"], weight=400)
        max_w = max(1, int(box["w"]))
        lines = self._wrap_caption_lines(text, font, max_w)
        if not lines:
            return
        try:
            rgb = self._parse_hex_color(box["color"])
        except Exception:
            rgb = (42, 42, 42)
        draw = ImageDraw.Draw(canvas)
        line_h = int(box["font_px"] * 1.25)
        x, y, w = box["x"], box["y"], box["w"]
        align = box["align"]
        for i, line in enumerate(lines):
            ly = y + i * line_h
            if align == "center":
                draw.text((x + w / 2, ly), line, font=font, fill=rgb, anchor="ma")
            elif align == "right":
                draw.text((x + w, ly), line, font=font, fill=rgb, anchor="ra")
            else:
                draw.text((x, ly), line, font=font, fill=rgb, anchor="la")

    def _composite_canvas(
        self,
        surface_def: dict,
        batch: List[str],
        fit_mode: str,
        mask_img,
        frame_transforms: Optional[List[dict]] = None,
        overlays: Optional[List[dict]] = None,
        uploaded_files: Optional[dict] = None,
        background: Optional[str] = None,
        paper_color: Optional[str] = None,
    ) -> Image.Image:
        """
        Composite one canvas from a batch of image file paths.
        Returns a flat RGB PIL Image — all transparency resolved, mask applied.

        background (optional): customer's canvas background colour ('#rrggbb'),
        shown beneath the frames and through any transparent image areas.
        Defaults to white. paper_color (optional): the mat colour painted around
        the frames (with frame-shaped holes). Both are omitted for legacy
        callers, keeping their output byte-identical.

        frame_transforms (optional): per-frame overrides from the editor state.
        Each entry matches the frontend FrameState shape:
          { offset_x, offset_y, scale, rotation, fit_mode }

        overlays (optional): list of TextOverlay / ShapeOverlay / ImageOverlay
        dicts for THIS canvas (Phase 1, CALENDAR_FEATURE_PRD.md §5). Rendered
        after frames and before the layout mask via services.overlay_renderer.
        Layouts with no overlays pay zero cost.

        uploaded_files (optional): { upload_id → server file path } map used
        to resolve `image`-type overlays that reference local uploads.
        """
        canvas_w = surface_def["canvas"]["width"]
        canvas_h = surface_def["canvas"]["height"]
        frames = surface_def.get("frames", [])

        # Bottom layer: the customer's background colour (white by default).
        bg_rgb = self._parse_hex_color(background)
        canvas = Image.new("RGB", (canvas_w, canvas_h), bg_rgb)

        # Free-placed captions (ops-positioned) are collected during the frame
        # loop and drawn at canvas level afterwards. px_per_mm == dpi/25.4.
        _cap_width_mm = surface_def["canvas"].get("widthMm")
        px_per_mm = (canvas_w / _cap_width_mm) if _cap_width_mm else (surface_def["canvas"].get("dpi", 300) / 25.4)
        deferred_captions: List[tuple] = []

        for idx, frame in enumerate(frames):
            # Position-explicit contract: batch[idx] pairs with frames[idx] and
            # frame_transforms[idx] by index. An empty/absent slot means the
            # customer left this frame without a resolvable photo — render it
            # blank instead of pulling the next image in and desynchronising
            # every later frame (the silent wrong-print bug). Guards both the
            # '' sentinel written by EditorRenderView for missing uploads and a
            # short batch from the legacy wrap-pad path.
            src_path = batch[idx] if idx < len(batch) else ""
            if not src_path:
                continue
            # Colour-managed load: EXIF orientation + ICC→sRGB conversion so a
            # Display-P3/AdobeRGB/CMYK-tagged photo prints the colours the
            # browser preview showed (services/image_loader.py).
            img = open_source_rgba(src_path)
            target_w = frame["width"]
            target_h = frame["height"]

            # Per-frame overrides from the editor (offset, scale, rotation, fit_mode).
            tx = frame_transforms[idx] if frame_transforms and idx < len(frame_transforms) else {}
            frame_fit = tx.get('fit_mode') or fit_mode
            # Clamp zoom to a sane ceiling: the editor slider tops out well
            # below 10, and an unbounded hostile value would multiply the
            # downscale target (memory) below.
            extra_scale = min(float(tx.get('scale') or 1.0), 10.0)
            rotation = float(tx.get('rotation') or 0.0)
            pan_x = float(tx.get('offset_x') or 0.0)
            pan_y = float(tx.get('offset_y') or 0.0)
            # WYSIWYG per-frame extras (fill sides + caption). Absent for legacy
            # callers, so their output stays byte-identical.
            fill_style = tx.get('fill_style') or None
            caption_text = (tx.get('caption') or '').strip()
            caption_on = bool(tx.get('caption_enabled')) and bool(caption_text)

            # Rotate source image if needed (expand=True preserves all pixels).
            # Fast-path 90/180/270° rotations: transpose is an O(1) memory
            # shuffle, vs the O(N) BICUBIC convolution `rotate` performs. Most
            # retro_polaroid renders use 90/180/270 — this collapses ~30% of
            # the surface render time for those layouts.
            if rotation:
                norm = int(rotation) % 360
                if rotation == norm and norm in (90, 180, 270):
                    if norm == 90:
                        img = img.transpose(Image.Transpose.ROTATE_270)  # rotate(-90)
                    elif norm == 180:
                        img = img.transpose(Image.Transpose.ROTATE_180)
                    else:  # 270
                        img = img.transpose(Image.Transpose.ROTATE_90)   # rotate(-270)
                else:
                    img = img.rotate(-rotation, expand=True, resample=Image.Resampling.BICUBIC)

            # Smart pre-downscale: shrink to 2× the ZOOMED frame target before
            # the cover/contain resize. A zoom of z crops the visible window to
            # 1/z of the source, so the pre-shrink must keep z× more pixels or
            # the 300 DPI print upsamples a pre-destroyed source (soft output
            # above 2× zoom). Zoom-out (scale < 1) keeps today's target.
            zoom_mult = max(1.0, extra_scale)
            img = self._smart_downscale(
                img,
                int(math.ceil(target_w * zoom_mult)),
                int(math.ceil(target_h * zoom_mult)),
            )

            if frame_fit == "contain":
                base_scale = min(target_w / img.width, target_h / img.height)
            else:
                base_scale = max(target_w / img.width, target_h / img.height)

            final_scale = base_scale * extra_scale
            new_w = max(1, int(img.width * final_scale))
            new_h = max(1, int(img.height * final_scale))
            img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)

            # Assemble this frame's pixels into a frame-sized RGBA layer, then
            # paste the layer onto the canvas. Compositing through a frame-sized
            # layer (rather than straight onto the canvas) does two things:
            #   1. Clips contain-mode pan/zoom to the frame box, so a zoomed or
            #      panned image can no longer bleed into a neighbouring frame.
            #   2. Lets us apply the frame's rounded/circular shape mask, so
            #      circle/rounded products (e.g. circle_48mm magnets) print in
            #      shape instead of as a white-cornered square.
            layer = Image.new("RGBA", (target_w, target_h), (0, 0, 0, 0))
            if frame_fit == "contain":
                rel_x = (target_w - new_w) // 2 + int(pan_x)
                rel_y = (target_h - new_h) // 2 + int(pan_y)
                # Fill sides: a contained photo leaves whitespace whenever its
                # aspect ratio differs from the frame's. If the customer picked a
                # fill style, paint it behind the photo (border colour or blurred
                # photo) so the frame reads edge-to-edge, matching the editor.
                if fill_style and (new_w < target_w or new_h < target_h):
                    self._paint_frame_fill(layer, img, fill_style, target_w, target_h, paper_color)
                layer.paste(img, (rel_x, rel_y), img)
            else:
                # Cover: crop to frame, then shift by editor pan offset.
                offset_x = max(0, (new_w - target_w) // 2 - int(pan_x))
                offset_y = max(0, (new_h - target_h) // 2 - int(pan_y))
                offset_x = min(offset_x, max(0, new_w - target_w))
                offset_y = min(offset_y, max(0, new_h - target_h))
                crop_box = (offset_x, offset_y, offset_x + target_w, offset_y + target_h)
                # Skip the crop call when the box already matches the image
                # bounds — saves a full pixel-buffer allocation + copy on
                # every cover-fit frame whose source already aligned.
                if crop_box != (0, 0, img.width, img.height):
                    img = img.crop(crop_box)
                layer.paste(img, (0, 0), img)

            # Per-frame caption. If the ops author positioned it (any caption*
            # field set on the layout frame), defer to a canvas-level draw below
            # so it can sit anywhere / unclipped. Otherwise keep the legacy
            # bottom-centre draw inside the frame layer (byte-identical output).
            # Wrapped defensively: a caption failure must never abort the frame.
            if caption_on:
                _cap_keys = ("captionXMm", "captionYMm", "captionWidthMm", "captionFontMm", "captionAlign", "captionColor")
                if any(frame.get(k) not in (None, "") for k in _cap_keys):
                    deferred_captions.append((
                        caption_text,
                        self._resolve_caption_box(frame["x"], frame["y"], frame["width"], frame["height"], frame, px_per_mm),
                    ))
                else:
                    try:
                        self._draw_frame_caption(layer, caption_text, target_w, target_h)
                    except Exception:
                        logger.exception("Caption render failed for frame %d; skipping caption", idx)

            # Clip to the frame's rounded/circular shape (no-op for square frames),
            # matching the browser preview so print == what the customer saw.
            self._apply_frame_shape_mask(layer, frame, surface_def)
            canvas.paste(layer, (frame["x"], frame["y"]), layer)
            layer.close()
            del layer
            img.close()
            del img

        # ── Paper mat (customer's paperColor around the frames) ──────────────
        # A full-canvas layer of the mat colour with frame-shaped holes, painted
        # above the photos (matching the browser paper overlay). Skipped when the
        # mat equals the background (invisible) — which keeps the common all-white
        # case byte-identical to before.
        if paper_color:
            paper_rgb = self._parse_hex_color(paper_color)
            if paper_rgb != bg_rgb:
                self._render_paper_mat(canvas, frames, surface_def, paper_rgb)

        # ── Free-placed captions ─────────────────────────────────────────────
        # Ops-positioned captions draw at canvas level (above photos + mat) so
        # they can sit anywhere on the page. Un-positioned (legacy) captions
        # were already drawn inside their frame layer above.
        for _cap_text, _cap_box in deferred_captions:
            try:
                self._draw_caption_box(canvas, _cap_text, _cap_box)
            except Exception:
                logger.exception("Free caption render failed; skipping")

        # ── Overlays (Phase 1 — CALENDAR_FEATURE_PRD.md §5) ──────────────────
        # Render text / shape / image overlays after frames but before the
        # mask, matching the editor's z-order (overlays above frames, below
        # mask). Layouts without overlays skip this branch entirely.
        if overlays:
            try:
                from services.overlay_renderer import render_overlays
                canvas = render_overlays(
                    canvas, overlays, canvas_w, canvas_h, uploaded_files or {},
                )
            except Exception:
                logger.exception("Overlay rendering failed; continuing without overlays")

        # ── Calendar (Phase 4 — CALENDAR_FEATURE_PRD.md §5) ──────────────────
        # Surfaces produced by `materialize_surfaces()` carry their resolved
        # year/month + per-cell user state + holidays. Each `calendars[i]`
        # primitive on the surface gets drawn at its own position. Sits
        # above overlays, below mask — matches the editor's z-order.
        #
        # P7.3 — Per-calendar (year, month) fall-through:
        #   If cal_def carries its own "year"+"month" (set by the poster-mode
        #   aggregation step in engine.generate()), those win over the
        #   surface-level values. This lets a single poster surface render
        #   12 different months without 12 separate _generate_for_surface
        #   calls. Multi-surface stays byte-identical — each surface still
        #   carries one calendar without per-calendar year/month.
        cal_primitives = surface_def.get("calendars") or []
        if cal_primitives:
            try:
                from services.calendar_renderer import render_calendar
                # Per-surface state comes from materialize_surfaces; if a
                # caller invokes _composite_canvas directly we still try
                # to render whatever's in surface_def with sane defaults.
                surface_year = int(surface_def.get("year") or 0)
                surface_month = int(surface_def.get("month") or 0)
                style = surface_def.get("calendar") or {}
                week_start = style.get("weekStart") or "sunday"
                user_cells_by_key = surface_def.get("cellsByKey") or None
                surface_user_cells = surface_def.get("cells") or {}
                holidays = surface_def.get("holidays") or []
                palette = surface_def.get("activePalette")
                for cal_def in cal_primitives:
                    cal_year = int(cal_def.get("year") or 0) or surface_year
                    cal_month = int(cal_def.get("month") or 0) or surface_month
                    if not (cal_year and cal_month):
                        continue
                    # Poster aggregation: per-calendar cells keyed by the
                    # surface_key ("month_03"). Fall back to surface-level
                    # cells for the standard (non-aggregated) path.
                    key = cal_def.get("surfaceKey")
                    cells = (
                        user_cells_by_key.get(key, {})
                        if (user_cells_by_key is not None and key is not None)
                        else surface_user_cells
                    )
                    render_calendar(
                        canvas, cal_def,
                        year=cal_year, month=cal_month,
                        style=style, week_start=week_start,
                        user_cells=cells, holidays=holidays,
                        canvas_w_px=canvas_w, canvas_h_px=canvas_h,
                        palette=palette,
                        uploaded_files=uploaded_files or {},
                    )
            except Exception:
                logger.exception("Calendar rendering failed; continuing without grid")

        if mask_img:
            resized_mask = mask_img
            mask_was_resized = False
            if mask_img.size != (canvas_w, canvas_h):
                resized_mask = mask_img.resize((canvas_w, canvas_h), Image.Resampling.LANCZOS)
                mask_was_resized = True
            canvas_rgba = canvas.convert("RGBA")
            canvas_rgba.alpha_composite(resized_mask)
            new_canvas = canvas_rgba.convert("RGB")
            canvas.close()
            canvas_rgba.close()
            if mask_was_resized:
                resized_mask.close()
            canvas = new_canvas

        return canvas

    def _iter_batches(self, surface_def: dict, image_paths: List[str]):
        """
        Yield (batch, n) for each image batch in this surface.
        n is 1-indexed and used for output filename numbering.
        """
        total_frames = len(surface_def.get("frames", []))
        i = 0
        n = 0
        while i < len(image_paths):
            batch = image_paths[i:i + total_frames]
            if len(batch) < total_frames:
                batch += image_paths[:total_frames - len(batch)]
            n += 1
            yield batch, n
            i += total_frames

    # ── PNG / TIFF export ────────────────────────────────────────────────────

    def _cleanup_partial_outputs(self, output_paths: List[str]) -> None:
        """
        Delete partial output files left on disk by a multi-surface render
        that aborted mid-batch (P7.2 — PRD §11.5). Best-effort: missing
        files are silently ignored; one file's cleanup failure does NOT
        block cleanup of the rest. Sibling preview JPEGs from `_mock`
        directory aren't created at this stage so no extra paths to chase.
        """
        for path in output_paths:
            try:
                if path and os.path.exists(path):
                    os.remove(path)
            except OSError as exc:
                logger.warning(
                    "Cleanup of partial output %s failed: %s — leaving on disk",
                    path, exc,
                )

    def _generate_for_surface(
        self,
        surface_def: dict,
        image_paths: List[str],
        layout_name: str,
        surface_key: str,
        fit_mode: str = "cover",
        export_format: str = "png",
        frame_transforms: Optional[List[dict]] = None,
        overlays_per_canvas: Optional[List[List[dict]]] = None,
        uploaded_files: Optional[dict] = None,
        display_label: Optional[str] = None,
        backgrounds_per_canvas: Optional[List[dict]] = None,
    ) -> List[str]:
        """
        Generate export files for a single surface.
        Returns a list of output file paths.

        export_format:
          "png" — RGB PNG at 300 DPI (default)
          "pdf" — RGB single-page PDF at 300 DPI

        display_label (P7.1 — PRD §11.6):
          When provided, the per-surface filename is derived from this human-
          readable label (e.g., "January 2026.png") rather than the layout
          name + surface_key. Used by calendar products and non-calendar
          multi-surface products with ops-set display labels (Front/Back/etc.).
          Filesystem-unsafe chars are replaced with underscores; falls back to
          the legacy `{layout_name}_{surface_key}_{n}` format when blank.
        """
        frames = surface_def.get("frames", [])
        if not frames:
            raise ValueError(f"No frames defined for surface '{surface_key}'")

        mask_img = None
        if surface_def.get("maskUrl") and surface_def.get("maskOnExport", False):
            mask_img = self._load_mask(surface_def["maskUrl"])
            # Pre-resize the mask once to canvas size so _composite_canvas
            # doesn't rerun LANCZOS for every batch in the surface. A 200-canvas
            # render previously did 200 mask resizes; now it does 1.
            canvas_w = surface_def["canvas"]["width"]
            canvas_h = surface_def["canvas"]["height"]
            if mask_img.size != (canvas_w, canvas_h):
                resized = mask_img.resize((canvas_w, canvas_h), Image.Resampling.LANCZOS)
                mask_img.close()
                mask_img = resized

        # ── Filename resolution (P7.1 — PRD §11.6) ─────────────────────────
        # When display_label is provided, use it as the file stem. Sanitize for
        # filesystem safety (keeps spaces; PRD example is "January 2026.png").
        # Fall back to the legacy {layout_name}{_surface_key} prefix when no
        # label is given so non-calendar legacy callers stay byte-identical.
        sanitized_label = _sanitize_for_filename(display_label or "")
        use_label = bool(sanitized_label)
        suffix = f"_{surface_key}" if surface_key != "default" else ""
        outputs = []

        frames_per_canvas = len(surface_def.get("frames", []))
        for batch_n, (batch, n) in enumerate(self._iter_batches(surface_def, image_paths)):
            # Slice the per-frame transform list to match this canvas's frames.
            batch_transforms = None
            if frame_transforms:
                start = batch_n * frames_per_canvas
                batch_transforms = frame_transforms[start: start + frames_per_canvas]

            # Pick this canvas's overlays from the per-canvas list (Phase 1).
            batch_overlays = None
            if overlays_per_canvas and batch_n < len(overlays_per_canvas):
                batch_overlays = overlays_per_canvas[batch_n]

            # Layout/materialized surface overlays (ops-authored artwork such
            # as calendar month titles — calendar_layout.materialize_surfaces
            # populates surface["overlays"]) render UNDER customer overlays,
            # matching the editor's z-order. They were previously dropped
            # entirely: the print carried only editor_state overlays.
            surface_overlays = surface_def.get("overlays") or []
            merged_overlays = (list(surface_overlays) + list(batch_overlays or [])) or None

            # Pick this canvas's background / paper colour (Phase 2). Same
            # per-canvas indexing as overlays above.
            batch_bg = None
            if backgrounds_per_canvas and batch_n < len(backgrounds_per_canvas):
                batch_bg = backgrounds_per_canvas[batch_n] or None

            canvas = self._composite_canvas(
                surface_def, batch, fit_mode, mask_img, batch_transforms,
                overlays=merged_overlays, uploaded_files=uploaded_files,
                background=(batch_bg or {}).get("bg"),
                paper_color=(batch_bg or {}).get("paper"),
            )

            # Stem resolution:
            #   - display_label set + first batch  →  "{label}"
            #   - display_label set + batch n > 1  →  "{label}_{n}"
            #     (calendar normally has one batch per surface; the suffix
            #      guards against an unexpected multi-batch case.)
            #   - no display_label                 →  "{layout_name}{suffix}_{n}"
            if use_label:
                stem = sanitized_label if n == 1 else f"{sanitized_label}_{n}"
            else:
                stem = f"{layout_name}{suffix}_{n}"
            ext = "pdf" if export_format == "pdf" else "png"
            out_path = os.path.join(self.exports_dir, f"{stem}.{ext}")
            self._write_output_atomic(canvas, out_path)

            outputs.append(out_path)
            canvas.close()
            del canvas
            gc.collect()

        if mask_img is not None:
            mask_img.close()

        return outputs

    # ── Public API ───────────────────────────────────────────────────────────

    def generate(
        self,
        layout_name: str,
        image_paths: List[str],
        fit_mode: str = "cover",
        export_format: str = "png",
        frame_transforms: Optional[List[dict]] = None,
        overlays_per_canvas: Optional[List[List[dict]]] = None,
        uploaded_files: Optional[dict] = None,
        calendar_state: Optional[dict] = None,
        backgrounds_per_canvas: Optional[List[dict]] = None,
        canvases_meta: Optional[List[dict]] = None,
    ) -> List[str]:
        """
        Generate layout images. Returns a list of output file paths.

        canvases_meta: optional per-payload-canvas metadata
          [{'surface_key': str|None, 'frame_count': int}, ...] in canvas order.
          When present, multi-surface products group photos/transforms/overlays
          per surface_key instead of rendering every surface against the whole
          list (Phase 3 — cross-surface wrong-print fix). Absent → legacy
          behaviour, byte-identical.

        export_format: "png" (default) or "pdf".
        frame_transforms: optional per-frame overrides (offset, scale, rotation, fit_mode)
          from the editor state — mirrors the Fabric.js FrameState shape.
        overlays_per_canvas: optional list-of-lists of overlay dicts, one entry
          per canvas batch (Phase 1, CALENDAR_FEATURE_PRD.md §5). Rendered after
          frames and before the mask.
        uploaded_files: optional { upload_id → server file path } map used to
          resolve `image`-type overlays.
        """
        layout = self._load_layout(layout_name)

        # Calendar product type (CALENDAR_FEATURE_PRD §5 Phase 4).
        # 1) Auto-derive 12 surfaces from the single template + monthRange
        #    + calendars[], honouring customer-side calendarType / palette /
        #    theme overrides at materialize time.
        # 2) Stamp each surface with its customer cells (if any), then
        #    delegate to the existing per-surface render loop.
        if layout.get("productType") == "calendar":
            from services.calendar_layout import materialize_surfaces
            all_outputs: List[str] = []

            cstate = calendar_state or {}
            ctype_override = cstate.get("calendar_type")
            theme_override = cstate.get("theme_preset")
            palette_override = cstate.get("palette")

            materialized = materialize_surfaces(
                layout,
                calendar_type_override=ctype_override,
                theme_preset_override=theme_override,
                palette_name_override=palette_override,
            )

            # Customer per-day entries as ONE flat { iso_date: [override] } map
            # (Phase 2 item 6 — entries are keyed by globally-unique ISO dates,
            # so positional per-canvas association was never needed and broke
            # whenever photo-canvas count ≠ 12 or the calendar type flipped).
            # render_calendar only draws in-month dates, so stamping the full
            # map on every surface is safe by construction. Legacy payloads
            # (cells_per_canvas list) merge losslessly: ISO keys are unique.
            flat_cells: dict = dict(cstate.get("cells") or {})
            if not flat_cells:
                for cell_map in cstate.get("cells_per_canvas") or []:
                    if isinstance(cell_map, dict):
                        flat_cells.update(cell_map)

            # Payload geometry for per-surface slicing. The frontend generates
            # photo canvases from the TEMPLATE frames (calendar overrides never
            # change the payload's frame count), so image_paths is
            # [c0f0, c0f1, ..., c1f0, ...] with a uniform stride.
            frames_per_payload_canvas = max(1, len(layout.get("frames") or []) or 1)
            num_payload_canvases = int(cstate.get("num_canvases") or 0)
            if not num_payload_canvases:
                num_payload_canvases = (
                    max(1, -(-len(image_paths) // frames_per_payload_canvas))
                    if image_paths else 0
                )

            # P7.3 — Poster-mode aggregation.
            # When monthRange.count == 1 and there are multiple calendars on
            # the single physical page, materialize_surfaces emits N entries
            # for ergonomic addressing (each "month_NN" key reachable per
            # the cell editor / surface override UI). The render side should
            # NOT produce N separate PNGs in this case — it must composite
            # all N calendars onto ONE canvas. Aggregate them here before
            # the per-surface render loop sees them.
            month_range = layout.get("monthRange") or {}
            poster_mode = (
                int(month_range.get("count") or 0) == 1
                and len(layout.get("calendars") or []) > 1
                and len(materialized) > 1
            )
            if poster_mode:
                base = materialized[0]
                merged_calendars: List[dict] = []
                cells_by_key: dict = {}
                # Union of all years' holidays so render_calendar's per-cell
                # date filter sees every holiday it might match.
                holiday_dedup: dict = {}
                for i, surf in enumerate(materialized):
                    # Every month-card reads the same flat map — each card's
                    # renderer only matches its own in-month ISO dates.
                    cells_by_key[surf.get("key")] = dict(flat_cells)
                    for cal_def in surf.get("calendars") or []:
                        merged = dict(cal_def)
                        merged["year"] = int(surf.get("year") or 0)
                        merged["month"] = int(surf.get("month") or 0)
                        merged["surfaceKey"] = surf.get("key")
                        merged_calendars.append(merged)
                    for h in surf.get("holidays") or []:
                        holiday_dedup[(h.get("date"), h.get("name"))] = h
                aggregate = {
                    **base,
                    "calendars": merged_calendars,
                    "holidays": list(holiday_dedup.values()),
                    "cellsByKey": cells_by_key,
                    # Drop the per-surface (year, month) so the renderer
                    # uses the merged calendar-level fields exclusively.
                    "year": 0,
                    "month": 0,
                    # Use the layout name (no month-specific displayLabel)
                    # since the poster is one physical PNG covering the
                    # whole year/FY.
                    "displayLabel": layout.get("displayLabel") or layout.get("name") or base.get("key"),
                }
                materialized = [aggregate]
                flat_cells = {}  # cells handled via cellsByKey above

            # P7.2 (PRD §11.5) — Multi-surface partial-failure handling.
            # If any 1 of N surfaces fails, fail the whole job: clean up
            # the partial outputs from prior surfaces (so retry doesn't
            # leave orphan PNGs on disk) and raise an error tagged with the
            # failing surface's displayLabel ("Render failed on March 2026")
            # so the task-layer error message tells the customer which month
            # broke.
            for surf_idx, surface in enumerate(materialized):
                surface_key = surface.get("key", "unknown")
                canvas_w = surface["canvas"]["width"]
                canvas_h = surface["canvas"]["height"]
                # Stamp the customer's per-day entries onto this surface so
                # _composite_canvas → render_calendar can pick them up.
                # The full flat map goes to every month; render_calendar's
                # in-month ISO filter draws only this month's entries.
                surface = {
                    **surface,
                    "cells": dict(flat_cells),
                    "frames": self._normalize_frames(surface.get("frames") or [], canvas_w, canvas_h),
                }
                # P7.1 — Calendar surface output filenames come from the
                # human-readable displayLabel ("January 2026.png" etc.) per
                # PRD §11.6, not the surface_key.
                display_label = surface.get("displayLabel") or surface_key

                # ── Per-surface payload slicing (Phase 2 item 6c/6d) ────────
                # Previously the FULL image_paths list went to every one of
                # the 12 month surfaces; _iter_batches then emitted one output
                # per photo batch per surface → 12·N files for N photos.
                # Each month renders exactly one photo-canvas: month i takes
                # canvas (i mod N), cycling when the customer uploaded fewer
                # canvases than months (1 photo → same photo on all 12).
                # Overlays and backgrounds slice with the same index; the old
                # code passed the whole overlays list, so every month rendered
                # canvas 0's overlays.
                if num_payload_canvases:
                    j = surf_idx % num_payload_canvases
                    lo = j * frames_per_payload_canvas
                    hi = lo + frames_per_payload_canvas
                    surface_images = image_paths[lo:hi]
                    surface_transforms = frame_transforms[lo:hi] if frame_transforms else None
                    surface_overlays_pc = (
                        [overlays_per_canvas[j]]
                        if overlays_per_canvas and j < len(overlays_per_canvas) else None
                    )
                    surface_backgrounds = (
                        [backgrounds_per_canvas[j]]
                        if backgrounds_per_canvas and j < len(backgrounds_per_canvas) else None
                    )
                else:
                    surface_images = image_paths
                    surface_transforms = frame_transforms
                    surface_overlays_pc = overlays_per_canvas
                    surface_backgrounds = backgrounds_per_canvas

                try:
                    all_outputs.extend(
                        self._generate_for_surface(
                            surface, surface_images, layout_name, surface_key,
                            fit_mode, export_format, surface_transforms,
                            overlays_per_canvas=surface_overlays_pc,
                            uploaded_files=uploaded_files,
                            display_label=display_label,
                            backgrounds_per_canvas=surface_backgrounds,
                        )
                    )
                except (MemoryError, SystemExit, KeyboardInterrupt):
                    # Don't swallow these — propagate immediately. Cleanup
                    # is still useful so we attempt it before re-raising.
                    self._cleanup_partial_outputs(all_outputs)
                    raise
                except Exception as exc:
                    logger.exception(
                        "Calendar surface %s/%d render failed (key=%s, label=%s)",
                        surf_idx + 1, len(materialized), surface_key, display_label,
                    )
                    self._cleanup_partial_outputs(all_outputs)
                    # Re-raise with a customer-facing message identifying the
                    # failing month so tasks.py can attach it to the
                    # RenderJob.error_message field for retry UX.
                    raise RuntimeError(
                        f"Render failed on {display_label} "
                        f"(surface {surf_idx + 1} of {len(materialized)}): {exc}"
                    ) from exc
            return all_outputs

        if layout.get("type") == "product" and isinstance(layout.get("surfaces"), list):
            all_outputs: List[str] = []

            # Per-surface payload grouping (Phase 3). The editor payload tags
            # every canvas with its surface_key; without grouping, EVERY
            # surface rendered against the FULL flattened photo list — a
            # 2-surface product cross-rendered each photo onto both outputs,
            # and an omitted/empty surface printed the OTHER surface's photo
            # (silent wrong print). Gated on canvases_meta so legacy
            # image_paths-only callers (GenerateLayoutView) stay byte-identical.
            canvas_starts: List[int] = []
            if canvases_meta:
                pos = 0
                for m in canvases_meta:
                    canvas_starts.append(pos)
                    pos += max(0, int(m.get("frame_count") or 0))

            for surface in layout["surfaces"]:
                surface_key = surface.get("key", "unknown")
                canvas_w = surface["canvas"]["width"]
                canvas_h = surface["canvas"]["height"]
                surface = {
                    **surface,
                    "frames": self._normalize_frames(surface.get("frames") or [], canvas_w, canvas_h),
                }
                # P7.1 — Non-calendar multi-surface products (cards, brochures)
                # also use ops-set displayLabel ("Front.png", "Back.png") per
                # PRD §11.6. Falls back to surface_key when displayLabel is
                # absent (legacy layouts without the field).
                display_label = surface.get("displayLabel") or None

                if canvases_meta:
                    idxs = [
                        i for i, m in enumerate(canvases_meta)
                        if (m.get("surface_key") or "default") == surface_key
                    ]
                    surf_images: List[str] = []
                    surf_transforms: List[dict] = []
                    for i in idxs:
                        lo = canvas_starts[i]
                        hi = lo + max(0, int(canvases_meta[i].get("frame_count") or 0))
                        surf_images.extend(image_paths[lo:hi])
                        if frame_transforms:
                            surf_transforms.extend(frame_transforms[lo:hi])
                    if not idxs:
                        # No canvas was submitted for this surface — render it
                        # BLANK (position-explicit '' slots) rather than letting
                        # _iter_batches steal another surface's photos.
                        surf_images = [""] * max(1, len(surface.get("frames") or []))
                    surf_overlays = (
                        [overlays_per_canvas[i] if i < len(overlays_per_canvas) else [] for i in idxs]
                        if overlays_per_canvas and idxs else None
                    )
                    surf_bgs = (
                        [backgrounds_per_canvas[i] if i < len(backgrounds_per_canvas) else {} for i in idxs]
                        if backgrounds_per_canvas and idxs else None
                    )
                    all_outputs.extend(
                        self._generate_for_surface(
                            surface, surf_images, layout_name, surface_key,
                            fit_mode, export_format, surf_transforms or None,
                            overlays_per_canvas=surf_overlays,
                            uploaded_files=uploaded_files,
                            display_label=display_label,
                            backgrounds_per_canvas=surf_bgs,
                        )
                    )
                else:
                    all_outputs.extend(
                        self._generate_for_surface(
                            surface, image_paths, layout_name, surface_key,
                            fit_mode, export_format, frame_transforms,
                            overlays_per_canvas=overlays_per_canvas,
                            uploaded_files=uploaded_files,
                            display_label=display_label,
                            backgrounds_per_canvas=backgrounds_per_canvas,
                        )
                    )
            return all_outputs

        return self._generate_for_surface(
            self._resolve_surface_def(layout),
            image_paths,
            layout_name,
            "default",
            fit_mode,
            export_format,
            frame_transforms,
            overlays_per_canvas=overlays_per_canvas,
            uploaded_files=uploaded_files,
            backgrounds_per_canvas=backgrounds_per_canvas,
        )
