# Bundled fonts (server-side renderer)

This directory holds the `.ttf` files that the Pillow-based overlay
renderer and calendar renderer use at 300 DPI.

## What lives here

Exactly one file:

```
Inter-Variable.ttf
```

Inter Variable is the **default** server-side font: calendar grids, captions,
and any text overlay without a family (or with a CSS generic such as
`sans-serif`, which the browser draws from the OS and we can't reproduce).

PRD §11.7's "one font, no picker" rule was **reversed on 2026-10-13**. A text
overlay now prints in the family the customer picked from the ops fonts list,
fetched from Google Fonts on first use and cached in storage — see
`services/google_fonts.py`. Those fonts are not bundled here.

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

The font picker (§11.7 reversed) does not use this directory. Picker fonts
come from Google Fonts at render time and are cached durably under
`font-cache/<family-slug>/<weight>.ttf` (S3 on prod, `storage/font_cache/`
locally) by `services/google_fonts.py`, which only fetches families on the
ops fonts list. Keep this directory single-file.
