import { roleLabel, type RoleFlags } from './roles';

/**
 * Display label for the signed-in user's role badge in the app header.
 *
 * Thin wrapper over `roleLabel` so the badge and the gates share one rule.
 * They used to diverge: this read `is_super_user`, a field PIA never sent, so
 * the elevated label could never appear at all.
 */
export function headerRoleLabel(flags?: RoleFlags | null): string {
  return roleLabel(flags);
}
