import { hasFullAccess, type AccessFlags } from './django-admin-access';

/**
 * Display label for the signed-in user's role badge in the app header.
 *
 * "Super Admin" uses the SAME rule as the Django-admin gate
 * (`lib/django-admin-access.ts`), so the badge and the actual privilege agree.
 * They used to diverge: the badge read `is_super_user`, a field PIA never
 * sends, so it could never appear — and once the gate moved to the all-flags
 * rule, a badge still keyed on the old field would have told an administrator
 * they were merely ops.
 */
export function headerRoleLabel(
  flags?: (AccessFlags & { is_super_user?: boolean }) | null,
): string {
  if (hasFullAccess(flags)) return 'Super Admin';
  if (flags?.is_ops_team) return 'Operations Team';
  return 'Designer';
}
