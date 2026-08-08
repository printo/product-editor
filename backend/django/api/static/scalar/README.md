# Vendored Scalar API Reference UI

This directory holds the standalone browser bundle for
[`@scalar/api-reference`](https://www.npmjs.com/package/@scalar/api-reference),
the UI that renders our OpenAPI schema at `/docs/api/`.

## What lives here

```
standalone.js
```

Vendored instead of loaded from `cdn.jsdelivr.net` so the docs page doesn't
depend on a third-party CDN and doesn't need a `CSP_SCRIPT_SRC` exception —
served same-origin, it's already covered by `'self'`.

## Current version

- **Version:** 1.64.1
- **License:** MIT
- **Source:** `https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.64.1/dist/browser/standalone.js`
- **sha256:** `397f33ac357dd4de28ea124499e97e315db98251015ea7e2b9870b575a4a1c3d`

## How to update

```bash
# from repo root — bump the version pin below to whatever's current
curl -L -o backend/django/api/static/scalar/standalone.js \
  https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.64.1/dist/browser/standalone.js
```

Then rebuild the backend image (`docker-compose build backend`) so
`collectstatic` picks up the new file — it only runs at image build time,
not on container start. Verify the build log shows the `collectstatic` layer
actually re-running, not `CACHED`.

Check the file still starts with a banner comment naming the version before
committing, and update the version/sha256 above.
