"""
The 500 MP Pillow ceiling must hold in every Django process.

The web process validates uploads with Pillow but never needs the render
engine. It used to get the ceiling only because api/views imported
layout_engine.engine for that side effect, so any process that set up Django
without importing the views refused photos above Pillow's default (~179 MP).
The ceiling is now set at startup in api/apps.py from
services.image_loader.MAX_IMAGE_PIXELS, and the engine uses the same number.

Each check runs in a fresh interpreter, so nothing this process has imported
can supply the ceiling by accident.

Run stand-alone:
    cd backend/django && DEBUG=1 python -m services.tests.test_image_pixel_cap
"""
from __future__ import annotations

import os
import subprocess
import sys
import textwrap

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _run(code: str) -> str:
    """Run code in a fresh interpreter and return its RESULT line."""
    env = dict(os.environ)
    env.setdefault('DJANGO_SETTINGS_MODULE', 'product_editor.settings')
    proc = subprocess.run(
        [sys.executable, '-c', textwrap.dedent(code)],
        capture_output=True, text=True, env=env, cwd=BACKEND_DIR,
    )
    assert proc.returncode == 0, proc.stderr[-2000:]
    lines = [line for line in proc.stdout.splitlines() if line.startswith('RESULT ')]
    assert lines, proc.stdout[-2000:]
    return lines[-1]


def test_django_startup_sets_the_ceiling_without_the_engine():
    out = _run('''
        import sys
        import django
        django.setup()
        from PIL import Image
        print('RESULT', Image.MAX_IMAGE_PIXELS, 'layout_engine.engine' in sys.modules)
    ''')
    assert out == 'RESULT 500000000 False', out


def test_the_render_engine_applies_the_same_ceiling():
    out = _run('''
        import django
        django.setup()
        from PIL import Image
        Image.MAX_IMAGE_PIXELS = 1          # importing the engine must set it back
        import layout_engine.engine  # noqa: F401
        from services.image_loader import MAX_IMAGE_PIXELS
        print('RESULT', Image.MAX_IMAGE_PIXELS, MAX_IMAGE_PIXELS)
    ''')
    assert out == 'RESULT 500000000 500000000', out


def test_upload_validation_accepts_a_photo_above_pillows_default_limit():
    # 14200 x 14200 = 201.6 MP: over Pillow's default refusal (~179 MP), under
    # 500 MP and the 16384 px side limit. A real all-black PNG, compressed row by
    # row so the test never holds the pixels in memory.
    out = _run('''
        import struct
        import sys
        import zlib
        import django
        django.setup()
        from django.core.files.uploadedfile import SimpleUploadedFile
        from api.validators import validate_image_file

        def chunk(kind, data):
            return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))

        side = 14200
        comp = zlib.compressobj()
        row = bytes(side + 1)
        idat = b''.join(comp.compress(row) for _ in range(side)) + comp.flush()
        png = (b'\\x89PNG\\r\\n\\x1a\\n'
               + chunk(b'IHDR', struct.pack('>IIBBBBB', side, side, 8, 0, 0, 0, 0))
               + chunk(b'IDAT', idat) + chunk(b'IEND', b''))
        validate_image_file(SimpleUploadedFile('big.png', png, content_type='image/png'))
        print('RESULT accepted', 'layout_engine.engine' in sys.modules)
    ''')
    assert out == 'RESULT accepted False', out


if __name__ == '__main__':
    fns = [v for k, v in sorted(globals().items()) if k.startswith('test_') and callable(v)]
    for fn in fns:
        fn()
        print(f'  ✓ {fn.__name__}')
    print(f'\n{len(fns)} image pixel-cap tests passed.')
