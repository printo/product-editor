#!/usr/bin/env python3
import json
import os
import sys

def export_from_filesystem(layouts_dir, output_path):
    """Export layouts from filesystem to JSON."""
    layouts = []
    
    if not os.path.isdir(layouts_dir):
        print(f"ERROR: Layouts directory not found: {layouts_dir}")
        return 0
    
    for filename in sorted(os.listdir(layouts_dir)):
        if not filename.endswith('.json'):
            continue
        
        filepath = os.path.join(layouts_dir, filename)
        try:
            with open(filepath, 'r') as f:
                layout_def = json.load(f)
            
            layout_def['name'] = filename[:-5]
            layouts.append(layout_def)
            print(f"  ✓ {filename}")
        except Exception as e:
            print(f"  ✗ {filename}: {e}")
    
    with open(output_path, 'w') as f:
        json.dump(layouts, f, indent=2)
    
    print(f"\nExported {len(layouts)} layouts to {output_path}")
    return len(layouts)

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: export_layout_catalogue.py <layouts_dir> <output_path>")
        sys.exit(1)
    
    layouts_dir = sys.argv[1]
    output_path = sys.argv[2]
    
    count = export_from_filesystem(layouts_dir, output_path)
    sys.exit(0 if count > 0 else 1)
