/**
 * Which internal-proxy paths require which tier.
 *
 * **Why this gate has to live here.** Everything reaching Django through the
 * internal proxy presents the shared, ops-flagged `INTERNAL_API_KEY` service
 * account, so Django's own `IsOpsTeam` permission sees one privileged identity
 * regardless of which human is signed in. This proxy is the only place that
 * knows who the person actually is, which makes it the only place a per-user
 * rule can be enforced.
 *
 * ## History, because this reverses a deliberate decision
 *
 * The proxy originally rejected every `ops/*` path unless `session.is_ops_team`.
 * PR #24 removed that blanket gate by product decision — template management
 * was opened to any authenticated user. That also, unintentionally, opened the
 * DPDP purge endpoint, so `DESTRUCTIVE_OPS_PATHS` below was added to re-gate
 * just that.
 *
 * The three-tier role model (`lib/roles.ts`, 2026-09-05) restores the blanket
 * gate: template, calendar and holiday management is the Ops tier, and the
 * Editor tier is upload / generate / download only. **The practical
 * consequence is that a designer who edits templates today loses that access**
 * unless they are flagged into the ops team — that is the intended change, not
 * a side effect.
 *
 * Reads stay open. Fetching the layout list, fonts and calendar styles is what
 * the editor itself does on mount, so gating those would break the Editor tier
 * outright; only writes are restricted.
 */

/**
 * Destructive endpoints, matched against the joined upstream path (no leading
 * slash, no `/api/` prefix) — e.g. `ops/orders/EXT-JOB-1/purge`.
 *
 * Matched on shape rather than an `ops/orders/` prefix so a future read-only
 * endpoint under the same namespace isn't caught by accident. Kept separate
 * from the tier rule below because these are irreversible: the purge hard
 * deletes an order's uploads, exports, CanvasData and EmbedSession rows along
 * with the files on disk.
 */
const DESTRUCTIVE_OPS_PATHS: RegExp[] = [
  /^ops\/orders\/[^/]+\/purge\/?$/, // DELETE /api/ops/orders/<order_id>/purge
];

/** True when the path may only be proxied for the Ops tier or above. */
export function isDestructiveOpsPath(upstreamPath: string): boolean {
  return DESTRUCTIVE_OPS_PATHS.some((re) => re.test(upstreamPath));
}

/** HTTP methods that change state. Anything else is a read. */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Ops-owned configuration that does NOT live under the `ops/` namespace.
 *
 * `fonts` is the one that matters today: the Fonts modal on `/editor/layouts`
 * saves with `PUT /api/fonts`, and it is ops-owned config in exactly the same
 * sense as layouts and calendar styles (see CLAUDE.md's storage table) — it
 * just never got the prefix. A namespace check alone would leave the whole
 * font list writable by any authenticated session while the layouts beside it
 * were gated.
 *
 * `calendar-styles` and `holidays` are the same trap from the other side:
 * Django mounts `CalendarStylesView` and `HolidaysView` on both the public
 * read paths and their `ops/` twins, and the write handlers never check which
 * route they arrived on. So `PUT calendar-styles/<name>` and
 * `PUT|DELETE holidays/<locale>/<year>` reached the same ops-only handlers as
 * the `ops/` paths while skipping the namespace check. Django now refuses
 * writes on those aliases (`api/urls.py`); gating them here too means neither
 * side depends on the other staying correct.
 *
 * Django gates these endpoints internally too, but that check cannot help
 * here: it inspects the shared ops-flagged service account this proxy
 * presents, not the human.
 */
const OPS_OWNED_PATHS: RegExp[] = [
  /^fonts(\/|$)/, // PUT /api/fonts — the ops Fonts list
  /^calendar-styles(\/|$)/, // alias of ops/calendar-styles/<name>
  /^holidays(\/|$)/, // alias of ops/holidays/<locale>/<year>
];

/**
 * True when this request manages ops-owned configuration — templates, calendar
 * styles, holidays, fonts — and therefore needs the Ops tier.
 *
 * Method-aware on purpose: `GET ops/layouts` is how the template library and
 * the editor list templates, and `GET fonts`, `GET calendar-styles/...` and
 * `GET holidays/...` are what the editor loads on mount. Gating reads would
 * break the Editor tier outright.
 */
export function requiresOpsTier(upstreamPath: string, method: string): boolean {
  if (!WRITE_METHODS.has(method.toUpperCase())) return false;
  if (/^ops(\/|$)/.test(upstreamPath)) return true;
  return OPS_OWNED_PATHS.some((re) => re.test(upstreamPath));
}
