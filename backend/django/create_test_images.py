#!/usr/bin/env python
"""
Create test images for render task verification.
"""
import os
from PIL import Image, ImageDraw, ImageFont

# Create test images
storage_root = os.getenv('STORAGE_ROOT', '/app/storage')
uploads_dir = os.path.join(storage_root, 'uploads')
os.makedirs(uploads_dir, exist_ok=True)

colors = [
    ('red', (255, 0, 0)),
    ('blue', (0, 0, 255)),
    ('green', (0, 255, 0)),
    ('yellow', (255, 255, 0)),
]

for name, color in colors:
    img = Image.new('RGB', (800, 600), color)
    draw = ImageDraw.Draw(img)
    
    # Draw a simple pattern
    draw.rectangle([100, 100, 700, 500], outline=(255, 255, 255), width=5)
    draw.ellipse([200, 200, 600, 400], fill=(255, 255, 255))
    
    # Save the image
    filepath = os.path.join(uploads_dir, f'test_{name}.png')
    img.save(filepath)
    print(f"Created: {filepath}")

print(f"\nCreated {len(colors)} test images in {uploads_dir}")
