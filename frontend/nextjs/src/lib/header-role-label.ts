import { isAdmin, roleLabel, type RoleFlags } from './roles';

/** What the header shows under the signed-in user's name. */
export interface HeaderRoleBadge {
  label: string;
  /** Set only for administrators: the badge doubles as the Django admin link. */
  href?: string;
}

/** Where the Django admin console lives. Served by nginx straight to Django,
 *  so it is a plain link, never a Next.js route. */
export const DJANGO_ADMIN_HREF = '/django-admin/';

/**
 * Display label (and link) for the signed-in user's role badge in the app
 * header.
 *
 * Thin wrapper over the gates in `roles.ts` so the badge and the gates share
 * one rule. They used to diverge: this read `is_super_user`, a field PIA never
 * sent, so the elevated label could never appear at all.
 *
 * An administrator's badge reads "Django Admin" and links to the console —
 * the same rule nginx's `auth_request` enforces via
 * `/api/internal/verify-django-admin`, so the link never appears for someone
 * the gate will deny. It replaced a separate toolbar button on the Templates
 * page that collided with the Fonts button on narrower screens.
 */
export function headerRoleBadge(flags?: RoleFlags | null): HeaderRoleBadge {
  if (isAdmin(flags)) return { label: 'Django Admin', href: DJANGO_ADMIN_HREF };
  return { label: roleLabel(flags) };
}
