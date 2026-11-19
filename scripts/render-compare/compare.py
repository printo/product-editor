"""Compare two run.py output folders file by file.

Usage (inside any backend image, which has numpy and Pillow):
    python /h/compare.py /before /after
"""
import hashlib
import os
import sys

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
a, b = sys.argv[1], sys.argv[2]
names = sorted(set(os.listdir(a)) | set(os.listdir(b)))
rows = []
for n in names:
    if n.startswith("_"):
        continue
    pa, pb = os.path.join(a, n), os.path.join(b, n)
    if not (os.path.exists(pa) and os.path.exists(pb)):
        rows.append((n, "MISSING in " + ("candidate" if os.path.exists(pa) else "baseline"), "", "", ""))
        continue
    ha = hashlib.md5(open(pa, "rb").read()).hexdigest()
    hb = hashlib.md5(open(pb, "rb").read()).hexdigest()
    if ha == hb:
        rows.append((n, "identical bytes", "", "", ""))
        continue
    if n.lower().endswith((".png", ".jpg", ".jpeg")):
        ia = np.asarray(Image.open(pa).convert("RGB"), dtype=np.int16)
        ib = np.asarray(Image.open(pb).convert("RGB"), dtype=np.int16)
        if ia.shape != ib.shape:
            rows.append((n, f"SIZE DIFFERS {ia.shape} vs {ib.shape}", "", "", ""))
            continue
        d = np.abs(ia - ib)
        mx = int(d.max())
        mean = float(d.mean())
        frac = float((d.max(axis=2) > 2).mean()) * 100
        verdict = "same pixels" if mx == 0 else ("tiny" if mx <= 2 else ("minor" if frac < 0.5 else "CHECK"))
        rows.append((n, verdict, f"max {mx}", f"mean {mean:.4f}", f"{frac:.3f}% px >2"))
    else:
        rows.append((n, f"bytes differ ({os.path.getsize(pa)} vs {os.path.getsize(pb)})", "", "", ""))
w = max(len(r[0]) for r in rows)
for r in rows:
    print(f"{r[0]:<{w}}  {r[1]:<28} {r[2]:<9} {r[3]:<14} {r[4]}")
