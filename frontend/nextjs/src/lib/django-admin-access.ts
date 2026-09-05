/**
 * Who may reach the Django admin.
 *
 * PIA has no admin tier — confirmed with their team 2026-09-05. The auth
 * response carries product-access flags only, so "is this person an
 * administrator?" is a question PIA cannot currently answer. Until it can,
 * this treats **every product flag being true** as the grant.
 *
 * ## Read this before relying on it
 *
 * This is a proxy for trust, not a grant of it, and PIA's own engineer flagged
 * the consequences. They are real and accepted deliberately:
 *
 *   - **Breadth of job becomes privilege.** Someone who legitimately needs
 *     DeliveryQ, ops and PIA chat for their day job becomes an administrator
 *     without anyone deciding that.
 *   - **It inverts on any flag change.** A fourth product flag added to
 *     `REQUIRED_FLAGS` silently locks out every current administrator; a flag
 *     removed from someone silently promotes the rest.
 *   - **It is not auditable.** "Who can delete our orders?" has no answer you
 *     can query — it is whatever the intersection of three product rosters
 *     happens to be today.
 *
 * The blast radius behind this gate is the whole database: orders, customer
 * uploads, API keys, embed sessions. Replace this with PIA's proposed
 * `is_admin` field as soon as it exists — one flag, granted per person,
 * queryable and revocable — and delete this module.
 *
 * ## Flags deliberately NOT in the rule
 *
 *   - `is_superuser` marks a **courier service account** in PIA and DENIES app
 *     access. It reads like the field we want and means close to the opposite;
 *     requiring it would make the rule unsatisfiable for humans and satisfiable
 *     for service accounts.
 *   - `is_staff` means "may log into a Django admin" but PIA enforces nothing
 *     with it, and it is not part of the product-flag set this rule is built
 *     from.
 *
 * Both are expected to disappear from the payload; nothing here depends on
 * them either way.
 */

/** The product flags that must ALL be true. Adding one here revokes access
 *  from everyone who lacks it — see the inversion warning above. */
export const REQUIRED_FLAGS = ['is_ops_team', 'is_deliveryq', 'pia_access'] as const;

export type AccessFlags = Partial<Record<(typeof REQUIRED_FLAGS)[number], boolean>>;

/**
 * True only when every flag in `REQUIRED_FLAGS` is exactly `true`.
 *
 * Strict equality, not truthiness: a missing flag reads as `undefined`, and a
 * payload that simply stopped carrying one must fail closed rather than be
 * coerced into a grant.
 */
export function hasFullAccess(flags?: AccessFlags | null): boolean {
  if (!flags) return false;
  return REQUIRED_FLAGS.every((flag) => flags[flag] === true);
}
