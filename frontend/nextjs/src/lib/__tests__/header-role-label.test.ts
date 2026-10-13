import { headerRoleBadge } from '../header-role-label';

describe('headerRoleBadge', () => {
  it('links administrators to the Django admin', () => {
    // Same rule as the Django-admin gate, so the badge cannot claim a
    // privilege the gate would refuse.
    expect(headerRoleBadge({ is_staff: true, is_ops_team: false })).toEqual({
      label: 'Django Admin',
      href: '/django-admin/',
    });
  });

  it('shows Operations Team for the ops tier, with no link', () => {
    expect(headerRoleBadge({ is_staff: false, is_ops_team: true })).toEqual({ label: 'Operations Team' });
  });

  it('shows Editor for everyone else, with no link', () => {
    expect(headerRoleBadge({ is_staff: false, is_ops_team: false })).toEqual({ label: 'Editor' });
    expect(headerRoleBadge(undefined)).toEqual({ label: 'Editor' });
    expect(headerRoleBadge(null)).toEqual({ label: 'Editor' });
  });

  it('ignores is_super_user, a field PIA never sent', () => {
    // The badge keyed on this for months, so the elevated label could never
    // appear at all.
    expect(headerRoleBadge({ is_super_user: true } as never)).toEqual({ label: 'Editor' });
  });
});
