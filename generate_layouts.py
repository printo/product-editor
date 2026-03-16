import json
import os

OUT_DIR = "/Users/kannaperumal/Code/product-editor/storage/layouts"
os.makedirs(OUT_DIR, exist_ok=True)

DPI = 300

def mm_to_px(mm: float) -> int:
    return round((mm / 25.4) * DPI)

def create_layout(name, layout_name, width_mm, height_mm, frames_def=None, bleed_mm=0):
    canvas_w = mm_to_px(width_mm)
    canvas_h = mm_to_px(height_mm)
    
    # Default is the whole canvas
    if not frames_def:
        frames_def = [{
            "id": "main_frame",
            "xMm": 0, "yMm": 0,
            "widthMm": width_mm, "heightMm": height_mm
        }]
    
    frames = []
    for f in frames_def:
        px_x = mm_to_px(f['xMm'])
        px_y = mm_to_px(f['yMm'])
        px_w = mm_to_px(f['widthMm'])
        px_h = mm_to_px(f['heightMm'])
        
        frames.append({
            "id": f['id'],
            "xMm": f['xMm'],
            "yMm": f['yMm'],
            "widthMm": f['widthMm'],
            "heightMm": f['heightMm'],
            "x": px_x / canvas_w,
            "y": px_y / canvas_h,
            "width": px_w / canvas_w,
            "height": px_h / canvas_h
        })

    layout_data = {
        "name": name,
        "canvas": {
            "width": canvas_w,
            "height": canvas_h,
            "widthMm": width_mm,
            "heightMm": height_mm,
            "dpi": DPI
        },
        "printableArea": {
            "x": 0.0,
            "y": 0.0,
            "width": 1.0,
            "height": 1.0,
            "xMm": 0,
            "yMm": 0,
            "widthMm": width_mm,
            "heightMm": height_mm,
            "bleedMm": bleed_mm
        },
        "frames": frames
    }

    path = os.path.join(OUT_DIR, f"{name}.json")
    with open(path, "w") as f:
        json.dump(layout_data, f, indent=4)
    print(f"Created {name}.json")

# Inche sizes
inch_sizes = {
    "4x6": (4, 6),
    "5x7": (5, 7),
    "6x8": (6, 8),
    "8x10": (8, 10),
    "A4": (8.27, 11.69),
    "9x12": (9, 12),
    "4x4": (4, 4),
    "5x5": (5, 5),
    "8x8": (8, 8)
}

# 1. Classic & Square Prints
for label, (w_in, h_in) in inch_sizes.items():
    create_layout(f"classic_{label}", f"Classic Print {label}", w_in * 25.4, h_in * 25.4)
    if w_in == h_in:
        create_layout(f"square_{label}", f"Square Print {label}", w_in * 25.4, h_in * 25.4)

# 3. Retro Polaroid (4.2 x 3.5 frame with smaller inner image, let's say 4.2h x 3.5w)
polaroid_w_mm = 3.5 * 25.4
polaroid_h_mm = 4.2 * 25.4
create_layout("retro_polaroid_42x35", "Retro Polaroid Print", polaroid_w_mm, polaroid_h_mm, [{
    "id": "polaroid_img",
    "xMm": polaroid_w_mm * 0.05,
    "yMm": polaroid_w_mm * 0.05,
    "widthMm": polaroid_w_mm * 0.9,
    "heightMm": polaroid_w_mm * 0.9 # Squareish image
}])

# 4. Passports & Stamps
# Canvas 4x6 (101.6 x 152.4 mm)
cw, ch = 4*25.4, 6*25.4

# Passports: 35 x 45 mm (cols=2, rows=3)
passports = []
idx = 1
for r in range(3):
    for c in range(2):
        passports.append({
            "id": f"pass_{idx}",
            "xMm": 10 + c * (35 + 10),
            "yMm": 10 + r * (45 + 5),
            "widthMm": 35,
            "heightMm": 45
        })
        idx += 1
create_layout("passport_prints", "Passport Prints on 4x6", cw, ch, passports)

# Stamps: 20 x 25 mm (cols=4, rows=5)
stamps = []
idx = 1
for r in range(5):
    for c in range(4):
        stamps.append({
            "id": f"stamp_{idx}",
            "xMm": 5 + c * (20 + 3),
            "yMm": 5 + r * (25 + 3),
            "widthMm": 20,
            "heightMm": 25
        })
        idx += 1
create_layout("stamp_prints", "Stamp Prints on 4x6", cw, ch, stamps)

# 5. Instant Printed Photos Set of 4 on a 4x6
instant_strip = []
idx = 1
for c in range(2):
    for r in range(2):
        instant_strip.append({
            "id": f"instant_{idx}",
            "xMm": 10 + c * (40+5),
            "yMm": 10 + r * (60+5),
            "widthMm": 40,
            "heightMm": 60
        })
        idx += 1
create_layout("instant_4up_4x6", "Instant 4-up on 4x6", cw, ch, instant_strip)

# 6. Bulk Photo Printing (just duplicates of classic basically, naming distinct per requirements)
create_layout("bulk_4x6", "Bulk Print 4x6", 4*25.4, 6*25.4)
create_layout("bulk_5x7", "Bulk Print 5x7", 5*25.4, 7*25.4)
create_layout("bulk_6x8", "Bulk Print 6x8", 6*25.4, 8*25.4)

print("Done standard layouts generation.")
