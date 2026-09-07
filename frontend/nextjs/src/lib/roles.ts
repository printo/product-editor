/**
 * The app's role model, derived from PIA's auth response.
 *
 * Three tiers, one flag each — no combinations, no coincidences:
 *
 *   | Tier   | Flag             | Gets                                        |
 *   |--------|------------------|---------------------------------------------|
 *   | Admin  | `is_staff`       | Django admin, plus everything below         |
 *   | Ops    | `is_ops_team`    | template / calendar / holiday management     |
 *   | Editor | authenticated    | upload, generate, download                  |
 *
 * `is_staff` is PIA's own "may log into a Django admin" flag, granted by their
 * tech team per person — so "who are our admins?" is one queryable column,
 * and adding a product flag next quarter changes nothing here. That is the
 * whole reason this replaced an earlier rule that required every product flag
 * to be true: an intersection of three product rosters made breadth of job
 * into privilege, inverted whenever a flag was added or removed, and could not
 * be audited.
 *
 * Flags deliberately absent from every decision:
 *
 *   - `is_superuser` is the field that looks like the one we want and is not.
 *     PIA described it as marking a **courier service account** that is DENIED
 *     app access — but the login log on 2026-09-07 showed `is_superuser=true`
 *     for a human employee with full access, so that description does not hold
 *     and nobody should rely on either reading of it. PIA is removing it from
 *     the payload from 2026-09-11. **Nothing here reads it**, which is why both
 *     its wrong meaning and its removal are no-ops for this app — the point of
 *     never having "fixed the spelling" from `is_super_user` to `is_superuser`.
 *   - `is_deliveryq` / `pia_access` grant access to other PIA products. They
 *     say nothing about this app and are carried only so the login log can
 *     report them.
 *
 * Confirmed contract with PIA's team, 2026-09-05:
 *
 *   { "is_staff": true, "is_ops_team": false, "is_deliveryq": true,
 *     "pia_access": true, "registration_status": "ACTIVE" }
 */

/** Flags this module reads. Everything is optional: a payload that stops
 *  carrying a flag must degrade to a lower tier, never a higher one. */
export interface RoleFlags {
  is_staff?: boolean;
  is_ops_team?: boolean;
  registration_status?: string;
}

/**
 * May reach the Django admin — read, edit and delete on every table.
 *
 * Strict `=== true`: a missing flag reads as `undefined`, and a payload that
 * quietly stopped carrying it must fail closed rather than be coerced.
 */
export function isAdmin(flags?: RoleFlags | null): boolean {
  return flags?.is_staff === true;
}

/**
 * May manage templates, calendar styles and holidays (the `ops/*` API).
 *
 * Admin implies ops — "everything below" in the table above — so an admin
 * never has to also be flagged into the ops team to use the tier beneath them.
 */
export function canManageTemplates(flags?: RoleFlags | null): boolean {
  return isAdmin(flags) || flags?.is_ops_team === true;
}

/** Label for the header badge. Same rules as the gates, so the badge can never
 *  claim a privilege the gates would refuse. */
export function roleLabel(flags?: RoleFlags | null): string {
  if (isAdmin(flags)) return 'Admin';
  if (canManageTemplates(flags)) return 'Operations Team';
  return 'Editor';
}

/**
 * Whether PIA considers this employee's registration active.
 *
 * PIA's `/auth/` does **not** refuse a login for a deactivated employee — they
 * confirmed that on 2026-09-05 — so a departed employee keeps working
 * credentials until we check this ourselves.
 *
 * Absence is treated as active, deliberately. Failing closed on a missing
 * field would lock out every user the moment PIA shipped a payload without it,
 * and the Google endpoint has already omitted a field the password endpoint
 * sent (`is_super_user`). Only an explicit status other than ACTIVE is a
 * rejection; an absent one is logged by the caller instead, so we notice
 * without an outage.
 */
export function isRegistrationActive(flags?: RoleFlags | null): boolean {
  const status = flags?.registration_status;
  if (status === undefined || status === null || status === '') return true;
  return String(status).trim().toUpperCase() === 'ACTIVE';
}
