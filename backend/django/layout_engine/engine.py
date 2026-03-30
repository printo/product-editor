import json
import os
import logging
from typing import List

from PIL import Image

logger = logging.getLogger(__name__)


class LayoutEngine:
    def __init__(self, layouts_dir: str, exports_dir: str):
        self.layouts_dir = layouts_dir
        self.exports_dir = exports_dir
        os.makedirs(self.exports_dir, exist_ok=True)

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
        return surface_def

    # ── Core compositing ─────────────────────────────────────────────────────

    def _composite_canvas(
        self,
        surface_def: dict,
        batch: List[str],
        fit_mode: str,
        mask_img,
    ) -> Image.Image:
        """
        Composite one canvas from a batch of image file paths.
        Returns a flat RGB PIL Image — all transparency resolved, mask applied.
        """
        canvas_w = surface_def["canvas"]["width"]
        canvas_h = surface_def["canvas"]["height"]
        frames = surface_def.get("frames", [])

        canvas = Image.new("RGB", (canvas_w, canvas_h), (255, 255, 255))

        for idx, frame in enumerate(frames):
            img = Image.open(batch[idx]).convert("RGBA")
            target_w = frame["width"]
            target_h = frame["height"]

            if fit_mode == "contain":
                scale = min(target_w / img.width, target_h / img.height)
            else:
                scale = max(target_w / img.width, target_h / img.height)

            new_w = int(img.width * scale)
            new_h = int(img.height * scale)
            img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)

            if fit_mode == "contain":
                paste_x = frame["x"] + (target_w - new_w) // 2
                paste_y = frame["y"] + (target_h - new_h) // 2
                canvas.paste(img, (paste_x, paste_y), img)
            else:
                offset_x = (new_w - target_w) // 2
                offset_y = (new_h - target_h) // 2
                crop_box = (offset_x, offset_y, offset_x + target_w, offset_y + target_h)
                img = img.crop(crop_box)
                canvas.paste(img, (frame["x"], frame["y"]), img)

        if mask_img:
            resized_mask = mask_img
            if mask_img.size != (canvas_w, canvas_h):
                resized_mask = mask_img.resize((canvas_w, canvas_h), Image.Resampling.LANCZOS)
            canvas_rgba = canvas.convert("RGBA")
            canvas_rgba.alpha_composite(resized_mask)
            canvas = canvas_rgba.convert("RGB")

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
    ) -> List[str]:
        """
        Generate export files for a single surface.
        Returns a list of output file paths.

        export_format:
          "png"       — RGB PNG at 300 DPI (default)
          "tiff_cmyk" — CMYK TIFF at 300 DPI (profile-less; for ICC use generate_soft_proof)
        """
        frames = surface_def.get("frames", [])
        if not frames:
            raise ValueError(f"No frames defined for surface '{surface_key}'")

        mask_img = None
        if surface_def.get("maskUrl") and surface_def.get("maskOnExport", False):
            mask_img = self._load_mask(surface_def["maskUrl"])

        suffix = f"_{surface_key}" if surface_key != "default" else ""
        outputs = []

        for batch, n in self._iter_batches(surface_def, image_paths):
            canvas = self._composite_canvas(surface_def, batch, fit_mode, mask_img)

            if export_format == "tiff_cmyk":
                out_path = os.path.join(self.exports_dir, f"{layout_name}{suffix}_{n}_cmyk.tif")
                canvas.convert("CMYK").save(out_path, "TIFF", dpi=(300, 300))
            else:
                out_path = os.path.join(self.exports_dir, f"{layout_name}{suffix}_{n}.png")
                # dpi=(300,300) injects the pHYs chunk — file is tagged as 300 DPI.
                canvas.save(out_path, "PNG", dpi=(300, 300))

            outputs.append(out_path)

        return outputs

    # ── Soft-proof export (ICC-calibrated CMYK pipeline) ────────────────────

    def _generate_soft_proof_for_surface(
        self,
        surface_def: dict,
        image_paths: List[str],
        layout_name: str,
        surface_key: str,
        fit_mode: str = "cover",
    ) -> List[dict]:
        """
        Full ICC-calibrated CMYK soft-proof pipeline for one surface.

        For each image batch produces four artefacts:
          ① Original RGB PNG        — what you designed
          ② CMYK TIFF               — send this to press (ISOcoated_v2 gamut-mapped)
          ③ Soft-proof RGB PNG      — on-screen simulation of how ② looks when printed
          ④ Colour-shift report     — avg/max pixel diff; flags significant gamut clipping

        The RGB→CMYK→RGB roundtrip (① → ② → ③) is the standard soft-proof technique.
        Any colour that falls outside the CMYK gamut is visible as a shift between ① and ③.
        The TIFF file embeds the ICC profile so the press operator's RIP uses it correctly.
        """
        from .cmyk import get_converter
        converter = get_converter()

        frames = surface_def.get("frames", [])
        if not frames:
            raise ValueError(f"No frames defined for surface '{surface_key}'")

        mask_img = None
        if surface_def.get("maskUrl") and surface_def.get("maskOnExport", False):
            mask_img = self._load_mask(surface_def["maskUrl"])

        suffix = f"_{surface_key}" if surface_key != "default" else ""
        results = []

        for batch, n in self._iter_batches(surface_def, image_paths):
            canvas_rgb = self._composite_canvas(surface_def, batch, fit_mode, mask_img)

            # ① Original RGB PNG — what you see on screen
            png_path = os.path.join(self.exports_dir, f"{layout_name}{suffix}_{n}.png")
            canvas_rgb.save(png_path, "PNG", dpi=(300, 300))

            # ② CMYK TIFF — ICC-calibrated press file
            canvas_cmyk = converter.to_cmyk(canvas_rgb)
            tif_path = os.path.join(self.exports_dir, f"{layout_name}{suffix}_{n}_cmyk.tif")
            canvas_cmyk.save(tif_path, "TIFF", dpi=(300, 300))

            # ③ Soft-proof RGB preview — CMYK gamut mapped back to screen colours
            #    This is what the physical print will look like
            preview_rgb = converter.to_rgb_preview(canvas_cmyk)
            prev_path = os.path.join(self.exports_dir, f"{layout_name}{suffix}_{n}_cmyk_preview.png")
            preview_rgb.save(prev_path, "PNG", dpi=(300, 300))

            # ④ Colour-shift report
            shift = converter.colour_shift_report(canvas_rgb, preview_rgb)

            results.append({
                "png": png_path,
                "tiff_cmyk": tif_path,
                "cmyk_preview": prev_path,
                "color_shift": shift,
            })

        return results

    # ── Public API ───────────────────────────────────────────────────────────

    def generate(
        self,
        layout_name: str,
        image_paths: List[str],
        fit_mode: str = "cover",
        export_format: str = "png",
    ) -> List[str]:
        """
        Generate layout images. Returns a list of output file paths.

        export_format: "png" (default) or "tiff_cmyk".
        For CMYK with soft-proof preview and colour-shift report use generate_soft_proof().
        """
        layout = self._load_layout(layout_name)

        if layout.get("type") == "product" and isinstance(layout.get("surfaces"), list):
            all_outputs: List[str] = []
            for surface in layout["surfaces"]:
                surface_key = surface.get("key", "unknown")
                all_outputs.extend(
                    self._generate_for_surface(
                        surface, image_paths, layout_name, surface_key, fit_mode, export_format
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
        )

    def generate_soft_proof(
        self,
        layout_name: str,
        image_paths: List[str],
        fit_mode: str = "cover",
    ) -> List[dict]:
        """
        Generate layout images with full ICC CMYK soft-proof pipeline.

        Returns a list of dicts, one per composited canvas:
          {
            "png":          path to original RGB PNG,
            "tiff_cmyk":    path to CMYK TIFF (send to press),
            "cmyk_preview": path to soft-proof RGB PNG (on-screen print simulation),
            "color_shift":  {
                avg_diff, max_pixel_diff, significant,
                using_icc_profile, profile, message
            }
          }
        """
        layout = self._load_layout(layout_name)

        if layout.get("type") == "product" and isinstance(layout.get("surfaces"), list):
            all_results: List[dict] = []
            for surface in layout["surfaces"]:
                surface_key = surface.get("key", "unknown")
                all_results.extend(
                    self._generate_soft_proof_for_surface(
                        surface, image_paths, layout_name, surface_key, fit_mode
                    )
                )
            return all_results

        return self._generate_soft_proof_for_surface(
            self._resolve_surface_def(layout),
            image_paths,
            layout_name,
            "default",
            fit_mode,
        )
