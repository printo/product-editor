# ICC Colour Profiles

This directory holds ICC profiles used for CMYK soft-proof conversion.

## Required file

**`ISOcoated_v2_eci.icc`** — ECI ISO Coated v2 profile (industry standard for offset printing
on coated paper; used by most Indian and European print shops, ISO 12647-2).

### Download (free)

1. Go to **http://www.eci.org/en/downloads** → "Offset printing" section
2. Download **"ISOcoated_v2_eci.icc"** (~2 MB)
3. Place it in this directory:

```
backend/django/icc_profiles/ISOcoated_v2_eci.icc
```

### Override path

If you place the file elsewhere, set the env var:

```
ICC_CMYK_PROFILE_PATH=/absolute/path/to/ISOcoated_v2_eci.icc
```

### What happens without the file

The system falls back to Pillow's built-in profile-less RGB→CMYK conversion.
Colours are close but not perceptually calibrated — saturated blues, greens, and
bright oranges may shift more than they would with a real press profile.
The colour-shift report will note which mode is active.

### Dockerfile note

To bundle the profile in the Docker image, place the file here and add:

```dockerfile
COPY backend/django/icc_profiles /app/icc_profiles
```

The path `icc_profiles/ISOcoated_v2_eci.icc` relative to the Django root is checked
automatically if `ICC_CMYK_PROFILE_PATH` is not set.
