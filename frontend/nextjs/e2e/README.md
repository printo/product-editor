# Editor smoke suite (Playwright)

Drives the real editor in your installed Google Chrome against the **local**
stack and a **production build** of this frontend. It is the browser half of
the safety net for splitting `page.tsx` (`docs/LARGE_FILE_SPLIT_PLAN.md`, part
2); the Jest characterization suite is the other half. Local only — GitHub
Actions is billing-locked for this org.

## Run it

```bash
cd frontend/nextjs
pnpm e2e                 # builds, starts on :3057, runs everything, stops the server
pnpm e2e:headed          # same, with a visible browser
pnpm e2e e2e/embed.spec.ts --project desktop -g "slow restore"   # one test
pnpm typecheck:e2e       # type-check the suite (the app's `pnpm typecheck` covers src/ only)
```

Needs: the local backend (`docker-compose up -d db redis backend`, published on
`127.0.0.1:8001` on this Mac), Google Chrome, and node 22 on PATH. The
"Download renders on the server" test also needs a **Celery worker** and skips
itself without one — start a throwaway one from the current backend image:

```bash
docker run -d --name pe-e2e-worker --network product-editor_web --env-file <copy of .env without inline comments> \
  -e REDIS_URL=redis://redis:6379/0 -e REDIS_CACHE_URL=redis://redis-cache:6379/0 -e STORAGE_ROOT=/app/storage \
  -v "$PWD/../../storage:/app/storage" product-editor-backend celery-worker
docker rm -f pe-e2e-worker    # afterwards
```

Settings (env vars, all optional) are documented at the top of
`support/env.ts`: `E2E_BASE_URL`, `E2E_API_URL`, `E2E_API_KEY`,
`E2E_ENV_LOCAL` / `E2E_ROOT_ENV` (where the secrets are read from — point them
at the main checkout when running from a worktree), `E2E_LAYOUT`,
`E2E_SERVER_COMMAND` (e.g. `pnpm start -p 3057` to reuse the last build),
`E2E_SKIP_SERVER=1` (use a server you started yourself).

**Safety:** it refuses to run unless both the frontend and the backend are on
this machine (`E2E_ALLOW_REMOTE=1` overrides). Every order it creates is purged
at the end through the ops erasure endpoint (`global-teardown.ts`).

## What it covers

| Spec | Journeys |
|---|---|
| `embed.spec.ts` | photos append, autosave, refresh restores them (with the photos); a restore held 5 s is never overwritten (PR #166, timed inside the page); quantity over/under; inside a storefront page — Back posts `pe:back`, Save & Continue uploads, renders (202) and posts `pe:render_job` to the parent, and the editor sends the printo.in `frame-ancestors` policy; a non-printo.in site cannot embed it; an iPhone HEIC photo converts; the canvas editor opens and closes; a cut-off photo's prompt takes focus and Escape cancels the pick; a card works from the keyboard (Enter on the card opens the editor, Enter on its Remove Photo asks first) and that confirm dialog opens on Cancel, keeps Tab inside and gives focus back on Escape |
| `dashboard.spec.ts` | signed in **without a password** (a NextAuth cookie minted with the local `AUTH_SECRET`): the template grid opens the editor; Download renders on the server and saves a ZIP containing print PNGs; imposition downloads print sheets; the print-sheet window opens on Close, keeps Tab inside and gives focus back to Download on Escape; the download options and the print-sheet window cover the top bar |
| `calendar.spec.ts` | the calendar preview shows its 12 months and loads the holidays the print carries |
| `phone.spec.ts` | on a Pixel 7 profile (touch): add photos, tap-to-swap them (checked in the autosave), open the editor sheet |
| `login.spec.ts` | the login form renders (never submitted — that would send credentials to the production PIA service); signed-out visitors are sent to `/login` |

## Gotchas found while building it

- **Run against a production build, not `pnpm dev`.** The dev bundler has broken
  paths the real app doesn't (pica's workers die under Turbopack).
- **`frame-ancestors` is baked in at build time** and *enforced* (not
  report-only). The test build adds the fake storefront origin via
  `NEXT_PUBLIC_EMBED_FRAME_ANCESTORS`; a server built without it will refuse
  the storefront tests, which is the policy working.
- **The fake storefront is a real local HTTP server**, not `page.route()`:
  Chrome treats a route-fulfilled page as public, and its Local Network Access
  checks then block it from framing localhost
  (`net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`).
- The downloaded ZIP is named by the server's `Content-Disposition`
  (`<layout>-<job id prefix>.zip`), which wins over the link's `download` name.
