# Bundled fonts (server-side renderer)

This directory holds the `.ttf` files that the Pillow-based overlay
renderer and calendar renderer use at 300 DPI.

## What lives here

Exactly one file:

```
Inter-Variable.ttf
```

Per PRD §11.7 the server-side renderer uses **only Inter Variable**. No
font picker is exposed to ops or customer; hardcoding one well-engineered
variable font (Apache 2.0 licence, weights 100–900 in a single file)
eliminates a class of production failure modes.

## How to install

```bash
# from repo root
curl -L -o backend/django/services/fonts_assets/Inter-Variable.ttf \
  https://github.com/rsms/inter/raw/master/docs/font-files/Inter-Variable.ttf
chmod 644 backend/django/services/fonts_assets/Inter-Variable.ttf
```

Or download the latest release zip from <https://github.com/rsms/inter/releases>
and copy `Inter.ttc` → `Inter-Variable.ttf` (rename only; same data).

The bundled font is loaded once per worker process on first render via
`services/fonts.get_font()`. If the file is absent the renderer falls
back to PIL's default bitmap font and logs a warning — output still
ships, just with ugly text. A boot-time `startup_check()` flags the
miss in the Django log so deploys never silently degrade.

## Licence

Inter is licensed under the SIL Open Font License 1.1
(<https://github.com/rsms/inter/blob/master/LICENSE.txt>). Bundling the
`.ttf` in our Docker image and shipping it as part of rendered PNGs is
explicitly permitted by OFL §1–3.

## Do NOT add more fonts here

If a future PRD adds a font picker (which would reverse §11.7), the new
contract should:

1. Read font names from `storage/fonts.json` (existing managed list).
2. Resolve each name to a `<FamilyName>.ttf` in this directory.
3. Add a startup check that every JSON entry has a matching `.ttf`.

Until then, every `.ttf` other than Inter-Variable.ttf is unused dead
weight in the Docker image — leave the directory single-file.
