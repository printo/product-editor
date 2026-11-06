# Test fixtures

- `Parisienne-Regular.ttf` — Parisienne by Astigmatic, SIL Open Font License 1.1
  (https://fonts.google.com/specimen/Parisienne/license). Fetched from Google
  Fonts (`fonts.gstatic.com/s/parisienne/v14/…`) so `test_google_fonts.py` can
  render a non-Inter family without network access.
- `Devanagari-Sample.ttf`, `Tamil-Sample.ttf` — small cuts of Poppins
  (Indian Type Foundry) and Hind Madurai (Indian Type Foundry), SIL Open Font
  License 1.1, as served by Google Fonts. Basic Latin plus the letters
  `test_indian_script_print.py` uses, with their joining rules (`GSUB`, `GPOS`)
  kept, so the print's shaping is tested without network access.
