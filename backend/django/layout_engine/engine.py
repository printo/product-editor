import gc
import json
import math
import os
import tempfile
import logging
from typing import List, Optional

from PIL import Image

logger = logging.getLogger(__name__)

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
    ) -> Image.Image:
        """
        Composite one canvas from a batch of image file paths.
        Returns a flat RGB PIL Image — all transparency resolved, mask applied.

        frame_transforms (optional): per-frame overrides from the editor state.
        Each entry matches the frontend FrameState shape:
          { offset_x, offset_y, scale, rotation, fit_mode }
        """
        canvas_w = surface_def["canvas"]["width"]
        canvas_h = surface_def["canvas"]["height"]
        frames = surface_def.get("frames", [])

        canvas = Image.new("RGB", (canvas_w, canvas_h), (255, 255, 255))

        for idx, frame in enumerate(frames):
            with Image.open(batch[idx]) as _src:
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

    def _generate_for_surface(
        self,
        surface_def: dict,
        image_paths: List[str],
        layout_name: str,
        surface_key: str,
        fit_mode: str = "cover",
        export_format: str = "png",
        frame_transforms: Optional[List[dict]] = None,
    ) -> List[str]:
        """
        Generate export files for a single surface.
        Returns a list of output file paths.

        export_format:
          "png" — RGB PNG at 300 DPI (default)
          "pdf" — RGB single-page PDF at 300 DPI
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

        suffix = f"_{surface_key}" if surface_key != "default" else ""
        outputs = []

        frames_per_canvas = len(surface_def.get("frames", []))
        for batch_n, (batch, n) in enumerate(self._iter_batches(surface_def, image_paths)):
            # Slice the per-frame transform list to match this canvas's frames.
            batch_transforms = None
            if frame_transforms:
                start = batch_n * frames_per_canvas
                batch_transforms = frame_transforms[start: start + frames_per_canvas]

            canvas = self._composite_canvas(surface_def, batch, fit_mode, mask_img, batch_transforms)

            if export_format == "pdf":
                out_path = os.path.join(self.exports_dir, f"{layout_name}{suffix}_{n}.pdf")
                # PIL's PDF writer expects RGB (no alpha). Composite is already
                # RGB by the time it reaches here, so save() works directly.
                self._write_output_atomic(canvas, out_path)
            else:
                out_path = os.path.join(self.exports_dir, f"{layout_name}{suffix}_{n}.png")
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
    ) -> List[str]:
        """
        Generate layout images. Returns a list of output file paths.

        export_format: "png" (default) or "pdf".
        frame_transforms: optional per-frame overrides (offset, scale, rotation, fit_mode)
          from the editor state — mirrors the Fabric.js FrameState shape.
        """
        layout = self._load_layout(layout_name)

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
                all_outputs.extend(
                    self._generate_for_surface(
                        surface, image_paths, layout_name, surface_key,
                        fit_mode, export_format, frame_transforms,
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
        )
