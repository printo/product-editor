/** Display label for the signed-in user's role badge in the app header. */
export function headerRoleLabel(
  flags?: { is_super_user?: boolean; is_ops_team?: boolean } | null,
): string {
  if (flags?.is_super_user) return 'Super Admin';
  if (flags?.is_ops_team) return 'Operations Team';
  return 'Designer';
}
