/**
 * Which internal-proxy paths stay ops-team-only.
 *
 * Background: the internal proxy used to reject every `ops/*` path unless
 * `session.is_ops_team`. PR #24 removed that blanket gate by product decision —
 * template management (layouts, calendar styles, holidays, fonts) is open to any
 * authenticated user.
 *
 * The catch is that the gate was the only thing distinguishing sessions.
 * Everything reaching Django through this proxy presents the shared, ops-flagged
 * INTERNAL_API_KEY service account, so Django's own IsOpsTeam permission sees one
 * privileged identity regardless of which human is signed in. Dropping the gate
 * wholesale therefore also opened the DPDP purge endpoint, which irreversibly
 * destroys an order's uploads, exports, CanvasData and EmbedSession rows along
 * with the files on disk.
 *
 * This module re-gates exactly the destructive endpoints and nothing else.
 * Keep the list minimal and precise: anything added here becomes unreachable for
 * ordinary staff, and anything omitted is reachable by every logged-in session.
 */

/**
 * Paths matched against the joined upstream path (no leading slash, no
 * `/api/` prefix) — e.g. `ops/orders/EXT-JOB-1/purge`.
 *
 * Matched on shape rather than an `ops/orders/` prefix so a future read-only
 * endpoint under the same namespace isn't caught by accident.
 */
const DESTRUCTIVE_OPS_PATHS: RegExp[] = [
  /^ops\/orders\/[^/]+\/purge\/?$/, // DELETE /api/ops/orders/<order_id>/purge
];

/** True when the path may only be proxied for a session with is_ops_team. */
export function isDestructiveOpsPath(upstreamPath: string): boolean {
  return DESTRUCTIVE_OPS_PATHS.some(re => re.test(upstreamPath));
}
