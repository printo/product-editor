import { headerRoleLabel } from '../header-role-label';

describe('headerRoleLabel', () => {
  it('shows Admin for is_staff', () => {
    // Same rule as the Django-admin gate, so the badge cannot claim a
    // privilege the gate would refuse.
    expect(headerRoleLabel({ is_staff: true, is_ops_team: false })).toBe('Admin');
  });

  it('shows Operations Team for the ops tier', () => {
    expect(headerRoleLabel({ is_staff: false, is_ops_team: true })).toBe('Operations Team');
  });

  it('shows Editor for everyone else', () => {
    expect(headerRoleLabel({ is_staff: false, is_ops_team: false })).toBe('Editor');
    expect(headerRoleLabel(undefined)).toBe('Editor');
    expect(headerRoleLabel(null)).toBe('Editor');
  });

  it('ignores is_super_user, a field PIA never sent', () => {
    // The badge keyed on this for months, so the elevated label could never
    // appear at all.
    expect(headerRoleLabel({ is_super_user: true } as never)).toBe('Editor');
  });
});
