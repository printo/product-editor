import gc
import json
import math
import os
import re
import tempfile
import logging
from typing import List, Optional

from PIL import Image, ImageOps

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
                    image_data.save(tmp_path, "PNG", dpi=(300, 300))
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

    def _composite_canvas(
        self,
        surface_def: dict,
        batch: List[str],
        fit_mode: str,
        mask_img,
        frame_transforms: Optional[List[dict]] = None,
        overlays: Optional[List[dict]] = None,
        uploaded_files: Optional[dict] = None,
    ) -> Image.Image:
        """
        Composite one canvas from a batch of image file paths.
        Returns a flat RGB PIL Image — all transparency resolved, mask applied.

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

        canvas = Image.new("RGB", (canvas_w, canvas_h), (255, 255, 255))

        for idx, frame in enumerate(frames):
            with Image.open(batch[idx]) as _src:
                # Apply EXIF orientation so the render starts from the same
                # "display upright" pixels the browser editor and the
                # orientation detector (services/orientation.py) both see.
                # Without this, EXIF-tagged camera photos (orientation 6/8)
                # render sideways even though the editor preview was upright —
                # the frame.rotation we receive is relative to the display view.
                ImageOps.exif_transpose(_src, in_place=True)
                img = _src.convert("RGBA")
            target_w = frame["width"]
            target_h = frame["height"]

            # Per-frame overrides from the editor (offset, scale, rotation, fit_mode).
            tx = frame_transforms[idx] if frame_transforms and idx < len(frame_transforms) else {}
            frame_fit = tx.get('fit_mode') or fit_mode
            extra_scale = float(tx.get('scale') or 1.0)
            rotation = float(tx.get('rotation') or 0.0)
            pan_x = float(tx.get('offset_x') or 0.0)
            pan_y = float(tx.get('offset_y') or 0.0)

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

            # Smart pre-downscale: shrink to 2× frame before the cover/contain resize.
            img = self._smart_downscale(img, target_w, target_h)

            if frame_fit == "contain":
                base_scale = min(target_w / img.width, target_h / img.height)
            else:
                base_scale = max(target_w / img.width, target_h / img.height)

            final_scale = base_scale * extra_scale
            new_w = max(1, int(img.width * final_scale))
            new_h = max(1, int(img.height * final_scale))
            img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)

            if frame_fit == "contain":
                paste_x = frame["x"] + (target_w - new_w) // 2 + int(pan_x)
                paste_y = frame["y"] + (target_h - new_h) // 2 + int(pan_y)
                canvas.paste(img, (paste_x, paste_y), img)
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
                canvas.paste(img, (frame["x"], frame["y"]), img)
            img.close()
            del img

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

            canvas = self._composite_canvas(
                surface_def, batch, fit_mode, mask_img, batch_transforms,
                overlays=batch_overlays, uploaded_files=uploaded_files,
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
    ) -> List[str]:
        """
        Generate layout images. Returns a list of output file paths.

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

            cells_per_canvas = cstate.get("cells_per_canvas") or []

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
                    cell_state = (
                        cells_per_canvas[i] if i < len(cells_per_canvas) else {}
                    )
                    cells_by_key[surf.get("key")] = cell_state or {}
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
                cells_per_canvas = [{}]  # cells handled via cellsByKey above

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
                cells = cells_per_canvas[surf_idx] if surf_idx < len(cells_per_canvas) else {}
                surface = {
                    **surface,
                    "cells": cells or {},
                    "frames": self._normalize_frames(surface.get("frames") or [], canvas_w, canvas_h),
                }
                # P7.1 — Calendar surface output filenames come from the
                # human-readable displayLabel ("January 2026.png" etc.) per
                # PRD §11.6, not the surface_key.
                display_label = surface.get("displayLabel") or surface_key
                try:
                    all_outputs.extend(
                        self._generate_for_surface(
                            surface, image_paths, layout_name, surface_key,
                            fit_mode, export_format, frame_transforms,
                            overlays_per_canvas=overlays_per_canvas,
                            uploaded_files=uploaded_files,
                            display_label=display_label,
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
                all_outputs.extend(
                    self._generate_for_surface(
                        surface, image_paths, layout_name, surface_key,
                        fit_mode, export_format, frame_transforms,
                        overlays_per_canvas=overlays_per_canvas,
                        uploaded_files=uploaded_files,
                        display_label=display_label,
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
        )
