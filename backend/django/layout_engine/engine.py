import json
import os
from typing import List
from PIL import Image

class LayoutEngine:
    def __init__(self, layouts_dir: str, exports_dir: str):
        self.layouts_dir = layouts_dir
        self.exports_dir = exports_dir
        os.makedirs(self.exports_dir, exist_ok=True)

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
        except Exception as e:
            print(f"Warning: Failed to load mask: {e}")
        return None

    def _generate_for_surface(
        self,
        surface_def: dict,
        image_paths: List[str],
        layout_name: str,
        surface_key: str,
        fit_mode: str = "cover",
    ) -> List[str]:
        """Generate canvases for a single surface definition."""
        canvas_w = surface_def["canvas"]["width"]
        canvas_h = surface_def["canvas"]["height"]
        frames = surface_def.get("frames", [])
        if not frames:
            raise ValueError(f"No frames defined for surface '{surface_key}'")

        total_frames = len(frames)
        outputs = []
        i = 0

        # Load mask if it should be applied to export
        mask_img = None
        if surface_def.get("maskUrl") and surface_def.get("maskOnExport", False):
            mask_img = self._load_mask(surface_def["maskUrl"])

        while i < len(image_paths):
            batch = image_paths[i:i+total_frames]
            if len(batch) < total_frames:
                repeat_needed = total_frames - len(batch)
                batch += image_paths[:repeat_needed]
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

            suffix = f"_{surface_key}" if surface_key != "default" else ""
            out_name = f"{layout_name}{suffix}_{len(outputs)+1}.png"
            out_path = os.path.join(self.exports_dir, out_name)
            canvas.save(out_path, "PNG")
            outputs.append(out_path)
            i += total_frames
        return outputs

    def generate(self, layout_name: str, image_paths: List[str], fit_mode: str = "cover") -> List[str]:
        layout = self._load_layout(layout_name)

        # Multi-surface product layout
        if layout.get("type") == "product" and isinstance(layout.get("surfaces"), list):
            all_outputs = []
            for surface in layout["surfaces"]:
                surface_key = surface.get("key", "unknown")
                outputs = self._generate_for_surface(surface, image_paths, layout_name, surface_key, fit_mode)
                all_outputs.extend(outputs)
            return all_outputs

        # Legacy single-surface layout — wrap as a surface definition
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

        return self._generate_for_surface(surface_def, image_paths, layout_name, "default", fit_mode)
