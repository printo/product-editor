import json
import os

OUT_DIR = "/Users/kannaperumal/Code/product-editor/storage/layouts"

DPI = 300

def px_to_mm(px: int) -> float:
    return round((px / DPI) * 25.4, 2)

for fname in os.listdir(OUT_DIR):
    if not fname.endswith(".json"):
        continue

    path = os.path.join(OUT_DIR, fname)
    with open(path, "r") as f:
        data = json.load(f)
    
    modified = False
    
    if "canvas" in data and "widthMm" not in data["canvas"]:
        data["canvas"]["widthMm"] = px_to_mm(data["canvas"]["width"])
        data["canvas"]["heightMm"] = px_to_mm(data["canvas"]["height"])
        data["canvas"]["dpi"] = data["canvas"].get("dpi", DPI)
        modified = True
        
    if "printableArea" not in data and "canvas" in data:
        data["printableArea"] = {
            "x": 0.0,
            "y": 0.0,
            "width": 1.0,
            "height": 1.0,
            "xMm": 0.0,
            "yMm": 0.0,
            "widthMm": data["canvas"]["widthMm"],
            "heightMm": data["canvas"]["heightMm"],
            "bleedMm": 0.0
        }
        modified = True
        
    if "frames" in data:
        for fr in data["frames"]:
            if "widthMm" not in fr and "canvas" in data:
                cw = data["canvas"]["width"]
                ch = data["canvas"]["height"]
                fr["xMm"] = px_to_mm(int(fr.get("x", 0) * cw))
                fr["yMm"] = px_to_mm(int(fr.get("y", 0) * ch))
                fr["widthMm"] = px_to_mm(int(fr.get("width", 0) * cw))
                fr["heightMm"] = px_to_mm(int(fr.get("height", 0) * ch))
                modified = True
                
    if modified:
        with open(path, "w") as f:
            json.dump(data, f, indent=4)
        print(f"Updated {fname}")
    else:
        print(f"Skipped {fname}")
