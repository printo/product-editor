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

    def generate(self, layout_name: str, image_paths: List[str], fit_mode: str = "cover") -> List[str]:
        layout = self._load_layout(layout_name)
        canvas_w = layout["canvas"]["width"]
        canvas_h = layout["canvas"]["height"]
        padding = layout.get("grid", {}).get("padding", 10)
        rows = layout.get("grid", {}).get("rows")
        cols = layout.get("grid", {}).get("cols")
        frames = layout.get("frames")
        if frames is None and rows and cols:
            frames = self._grid_frames(canvas_w, canvas_h, rows, cols, padding)
        if not frames:
            raise ValueError("No frames defined for layout")

        total_frames = len(frames)
        outputs = []
        i = 0
        
        # Load mask if it should be applied to export
        mask_img = None
        if layout.get("maskUrl") and layout.get("maskOnExport", False):
            try:
                # Resolve local path for mask (stored in masks_dir)
                mask_filename = os.path.basename(layout["maskUrl"])
                mask_path = os.path.join(os.path.dirname(self.layouts_dir), "masks", mask_filename)
                if os.path.exists(mask_path):
                    mask_img = Image.open(mask_path).convert("RGBA")
            except Exception as e:
                print(f"Warning: Failed to load mask: {e}")

        while i < len(image_paths):
            batch = image_paths[i:i+total_frames]
            if len(batch) < total_frames:
                repeat_needed = total_frames - len(batch)
                batch += image_paths[:repeat_needed]
            canvas = Image.new("RGB", (canvas_w, canvas_h), (255, 255, 255))
            for idx, frame in enumerate(frames):
                img = Image.open(batch[idx]).convert("RGBA") # Use RGBA to preserve transparency if needed
                
                # Calculate fit (contain = show full image, cover = fill frame)
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
                    # Center the image within the frame (may have empty space)
                    paste_x = frame["x"] + (target_w - new_w) // 2
                    paste_y = frame["y"] + (target_h - new_h) // 2
                    canvas.paste(img, (paste_x, paste_y), img)
                else:
                    # Center crop for cover mode
                    offset_x = (new_w - target_w) // 2
                    offset_y = (new_h - target_h) // 2
                    crop_box = (offset_x, offset_y, offset_x + target_w, offset_y + target_h)
                    img = img.crop(crop_box)
                    canvas.paste(img, (frame["x"], frame["y"]), img)
            
            # Apply mask if available
            if mask_img:
                # Ensure mask is same size as canvas
                if mask_img.size != (canvas_w, canvas_h):
                    mask_img = mask_img.resize((canvas_w, canvas_h), Image.Resampling.LANCZOS)
                canvas_rgba = canvas.convert("RGBA")
                canvas_rgba.alpha_composite(mask_img)
                canvas = canvas_rgba.convert("RGB")

            out_name = f"{layout_name}_{len(outputs)+1}.png"
            out_path = os.path.join(self.exports_dir, out_name)
            canvas.save(out_path, "PNG")
            outputs.append(out_path)
            i += total_frames
        return outputs
